// HTTP API and static frontend. The demo identity comes from an HMAC-signed session
// cookie (a simulated sign-in, not authentication). Every confidential route resolves
// the viewer server-side and goes through the service's access checks.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { keccak256, toUtf8Bytes } from "ethers";
import { LedgerError } from "./chain.ts";
import { ROOT, type AppConfig } from "./config.ts";
import { DECISION_NAMES, DECISIONS_FOR_KIND, DISPUTE_KIND_NAMES, IDENTITY_DEFS, LOG_KINDS, PROGRAMS, REASON_CODES, RELATION_NAMES, SEVERITIES, STATUS } from "./domain.ts";
import { auditReport, verifyAuditExport } from "./integrity.ts";
import { TamperLab } from "./lab.ts";
import { MAX_EVIDENCE, ServiceError, type VulnSealService } from "./service.ts";
import { SESSION_COOKIE, readCookie, type Sessions } from "./session.ts";
import { DemoRunner } from "./demo.ts";

const num = (v: unknown, name = "id") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ServiceError(`${name} must be a positive integer`, 422);
  return n;
};

interface BenchState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  params: Record<string, number> | null;
  log: string;
}

export function createApp(svc: VulnSealService, sessions: Sessions, cfg: AppConfig) {
  const app = express();
  const lab = new TamperLab(svc);
  const demo = new DemoRunner(svc);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_EVIDENCE, files: 1 } });
  const bench: BenchState = { running: false, startedAt: null, finishedAt: null, exitCode: null, params: null, log: "" };
  let benchProc: ChildProcess | null = null;

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "512kb" }));

  const viewerOf = (req: Request) => svc.viewer(sessions.verify(readCookie(req.headers.cookie, SESSION_COOKIE)));
  const me = (req: Request) => svc.requireViewer(sessions.verify(readCookie(req.headers.cookie, SESSION_COOKIE)));
  const download = (res: Response, name: string, body: unknown) => {
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.type("application/json").send(JSON.stringify(body, null, 2));
  };

  const api = express.Router();

  // ----------------------------------------------------------------- basics
  api.get("/health", async (_req, res) => {
    try {
      const block = await svc.ledger.ping();
      res.json({ ok: true, chain: { ok: true, blockNumber: block, contract: svc.ledger.address, chainId: svc.ledger.chainId, rpcUrl: svc.ledger.rpcUrl } });
    } catch (e) {
      res.status(503).json({ ok: false, chain: { ok: false, error: (e as Error).message, rpcUrl: svc.ledger.rpcUrl } });
    }
  });

  api.get("/meta", (_req, res) => {
    res.json({
      identities: svc.identities(),
      programs: PROGRAMS,
      statuses: STATUS,
      relations: RELATION_NAMES,
      disputeKinds: DISPUTE_KIND_NAMES,
      decisions: DECISION_NAMES,
      decisionsForKind: DECISIONS_FOR_KIND,
      reasonCodes: REASON_CODES,
      logKinds: LOG_KINDS,
      severities: SEVERITIES,
      demoLab: cfg.demoLab,
      simulatedAuth: true,
    });
  });

  api.get("/session", (req, res) => res.json({ identity: viewerOf(req) ?? null }));
  api.post("/session", (req, res) => {
    const id = String(req.body?.identityId ?? "");
    if (!IDENTITY_DEFS.some((d) => d.id === id)) throw new ServiceError("Unknown demo identity", 422);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sessions.issue(id))}; Path=/; HttpOnly; SameSite=Strict`);
    res.json({ identity: svc.viewer(id) });
  });
  api.delete("/session", (_req, res) => {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ identity: null });
  });

  api.get("/dashboard", async (_req, res) => res.json(await svc.dashboard()));
  api.get("/explorer", async (_req, res) => res.json(await svc.explorer()));
  api.get("/programs", async (_req, res) => res.json(await svc.programs()));
  api.get("/events", (req, res) => res.json(svc.auditEvents(Math.min(500, Number(req.query.limit ?? 200)))));

  // ------------------------------------------------------------- researcher
  api.get("/me/reports", async (req, res) => res.json(await svc.myReports(me(req))));
  api.post("/evidence", upload.single("file"), (req, res) => {
    const f = req.file;
    res.status(201).json(svc.uploadEvidence(me(req), f ? { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype } : undefined));
  });
  api.get("/evidence/:id", async (req, res) => {
    const f = await svc.evidenceFile(me(req), String(req.params.id));
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${String(f.filename).replace(/"/g, "")}"`);
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.send(f.data);
  });
  api.post("/reports", async (req, res) => res.status(201).json(await svc.commitReport(me(req), req.body ?? {})));
  api.get("/reports/:cid", async (req, res) => res.json(await svc.reportView(me(req), num(req.params.cid))));
  api.post("/reports/:cid/revise", async (req, res) => res.status(201).json(await svc.reviseReport(me(req), num(req.params.cid), req.body ?? {})));
  api.get("/reports/:cid/receipt", async (req, res) => {
    const r = await svc.receipt(me(req), num(req.params.cid));
    download(res, `vulnseal-receipt-${r.reportRef}.json`, r);
  });
  api.get("/reports/:cid/recovery", async (req, res) => {
    const p = await svc.recoveryPackage(me(req), num(req.params.cid));
    download(res, `vulnseal-PRIVATE-reveal-package-${p.receipt.reportRef}.json`, p);
  });
  api.post("/reports/:cid/reveal", async (req, res) => res.status(201).json(await svc.submitReveal(me(req), num(req.params.cid), req.body ?? {})));

  // ---------------------------------------------------------------- program
  api.get("/program/inbox", async (req, res) => res.json(await svc.programInbox(me(req))));
  api.post("/reports/:cid/acknowledge", async (req, res) => res.json(await svc.acknowledge(me(req), num(req.params.cid))));
  api.post("/reports/:cid/request-reveal", async (req, res) => res.json(await svc.requestReveal(me(req), num(req.params.cid))));
  api.post("/reveals/:id/verify", async (req, res) => res.json(await svc.verifyReveal(me(req), num(req.params.id))));
  api.post("/reports/:cid/triage", async (req, res) => res.json(await svc.triage(me(req), num(req.params.cid), String(req.body?.target ?? ""), String(req.body?.note ?? ""))));
  api.post("/reports/:cid/notes", (req, res) => res.status(201).json(svc.addNote(me(req), num(req.params.cid), String(req.body?.body ?? ""))));
  api.post("/reports/:cid/grant", async (req, res) => res.json(await svc.grantDisclosure(me(req), num(req.params.cid), num(req.body?.toProgram, "toProgram"))));
  api.post("/reports/:cid/finalize", async (req, res) => res.json(await svc.finalizeReport(me(req), num(req.params.cid), String(req.body?.note ?? ""))));

  // ----------------------------------------------------------- associations
  api.post("/associations", async (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(await svc.proposeAssociation(me(req), num(b.cidA, "cidA"), num(b.cidB, "cidB"), num(b.relation, "relation"), String(b.rationale ?? "")));
  });
  api.get("/associations/:aid", async (req, res) => res.json(await svc.associationView(me(req), num(req.params.aid))));
  api.post("/associations/:aid/review", async (req, res) =>
    res.json(await svc.reviewAssociation(me(req), num(req.params.aid), req.body?.approve === true, String(req.body?.rationale ?? ""))),
  );

  // --------------------------------------------------------------- disputes
  api.get("/disputes", async (_req, res) => res.json(await svc.disputes()));
  api.post("/disputes", async (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(await svc.openDispute(me(req), num(b.kind, "kind"), num(b.subject, "subject"), String(b.statement ?? "")));
  });
  api.get("/disputes/:did", async (req, res) => res.json(await svc.disputeView(me(req), num(req.params.did))));
  api.post("/disputes/:did/vote", async (req, res) => {
    const b = req.body ?? {};
    res.json(await svc.vote(me(req), num(req.params.did), num(b.decision, "decision"), num(b.reasonCode, "reasonCode"), String(b.rationale ?? "")));
  });
  api.post("/disputes/:did/recuse", async (req, res) => res.json(await svc.recuse(me(req), num(req.params.did))));
  api.post("/disputes/:did/appeal", async (req, res) => res.json(await svc.appeal(me(req), num(req.params.did), String(req.body?.statement ?? ""))));
  api.post("/disputes/:did/close", async (req, res) => res.json(await svc.closeDispute(me(req), num(req.params.did))));

  // ---------------------------------------------------------- verification
  api.post("/verify/receipt", async (req, res) => res.json(await svc.verifyReceipt(req.body?.receipt, req.body?.reveal)));

  const auditor = (req: Request) => {
    const v = me(req);
    if (v.kind !== "auditor" && v.kind !== "governor") throw new ServiceError("The audit report is available to the consortium auditor.", 403);
    return v;
  };
  api.get("/audit/report", async (req, res) => {
    auditor(req);
    const r = await auditReport(svc);
    res.json({ ...r, log: r.log.slice(-60), logTotal: r.log.length });
  });
  api.get("/audit/export", async (req, res) => {
    auditor(req);
    download(res, `vulnseal-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, await auditReport(svc));
  });
  api.post("/audit/verify-export", (req, res) => res.json(verifyAuditExport(req.body)));
  api.post("/audit/attest", async (req, res) => {
    const v = auditor(req);
    const r = await auditReport(svc);
    const digest = keccak256(toUtf8Bytes(JSON.stringify({ head: r.chain.logHead, count: r.chain.logCount, ok: r.ok, findings: r.findings.map((f) => f.code) })));
    const tx = await svc.tx(v.id, "attest", [digest]);
    res.json({ tx: tx.hash, digest, ok: r.ok, logCount: r.chain.logCount });
  });
  api.get("/access-log", (req, res) => res.json(svc.accessLog(me(req))));

  // ------------------------------------------------------------ tamper lab
  const labGuard = (req: Request, _res: Response, next: NextFunction) => {
    if (!cfg.demoLab) throw new ServiceError("The tamper lab is disabled (VS_DEMO_LAB=0)", 403);
    const v = me(req);
    if (v.kind !== "auditor" && v.kind !== "governor") throw new ServiceError("The tamper lab is run from the auditor identity.", 403);
    next();
  };
  api.get("/lab/state", labGuard, (_req, res) => res.json(lab.state()));
  api.post("/lab/alter-reveal", labGuard, (req, res) => res.json(lab.alterReveal(num(req.body?.revealId, "revealId"))));
  api.post("/lab/alter-commitment", labGuard, (req, res) => res.json(lab.alterCommitment(num(req.body?.cid, "cid"))));
  api.post("/lab/delete-event", labGuard, (req, res) => res.json(lab.deleteEvent(num(req.body?.seq, "seq"))));
  api.post("/lab/alter-evidence", labGuard, (req, res) => res.json(lab.alterEvidence(String(req.body?.evidenceId ?? ""))));
  api.post("/lab/alter-rationale", labGuard, (req, res) => res.json(lab.alterRationale(num(req.body?.aid, "aid"))));
  api.post("/lab/chain-attempts", labGuard, async (req, res) => res.json(await lab.chainAttempts(num(req.body?.cid, "cid"))));
  api.post("/lab/restore", labGuard, (_req, res) => res.json(lab.restoreAll()));

  // ------------------------------------------------------------- demo mode
  api.get("/demo", (_req, res) => res.json(demo.state()));
  api.post("/demo/step", async (req, res) => res.json(await demo.runNext(viewerOf(req))));
  api.post("/demo/reset", (_req, res) => res.json(demo.reset()));

  // ------------------------------------------------------------- benchmark
  api.get("/benchmark/latest", (_req, res) => {
    const p = path.join(cfg.resultsDir, "latest.json");
    if (!fs.existsSync(p)) throw new ServiceError("No benchmark results yet. Run one from this page or with npm run benchmark.", 404);
    res.type("application/json").send(fs.readFileSync(p, "utf8"));
  });
  api.get("/benchmark/report", (_req, res) => {
    const p = path.join(cfg.resultsDir, "latest.md");
    if (!fs.existsSync(p)) throw new ServiceError("No benchmark report yet", 404);
    res.type("text/markdown").send(fs.readFileSync(p, "utf8"));
  });
  api.get("/benchmark/status", (_req, res) => res.json(bench));
  api.post("/benchmark/run", (req, res) => {
    if (bench.running) throw new ServiceError("A benchmark is already running", 409);
    const params = { reports: Number(req.body?.reports ?? 40), seed: Number(req.body?.seed ?? 42), trials: Number(req.body?.trials ?? 10) };
    for (const [k, v, max] of [["reports", params.reports, 400], ["seed", params.seed, 2 ** 31], ["trials", params.trials, 50]] as const) {
      if (!Number.isInteger(v) || v < 1 || v > max) throw new ServiceError(`${k} must be an integer between 1 and ${max}`, 422);
    }
    Object.assign(bench, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, params, log: "" });
    benchProc = spawn(process.execPath, ["scripts/benchmark.ts", "--reports", String(params.reports), "--seed", String(params.seed), "--trials", String(params.trials), "--out", cfg.resultsDir], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (d: Buffer) => (bench.log = (bench.log + d.toString()).slice(-8000));
    benchProc.stdout?.on("data", append);
    benchProc.stderr?.on("data", append);
    benchProc.on("exit", (code) => {
      Object.assign(bench, { running: false, finishedAt: new Date().toISOString(), exitCode: code });
      benchProc = null;
    });
    res.status(202).json(bench);
  });

  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API route" }));

  // ------------------------------------------------------------- frontend
  if (fs.existsSync(path.join(cfg.webDist, "index.html"))) {
    app.use(express.static(cfg.webDist, { index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'",
      );
      res.sendFile(path.join(cfg.webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => res.type("text").send("VulnSeal API is running. Build the frontend with npm run build:web."));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message });
    if (err instanceof LedgerError) return res.status(err.status).json({ error: err.message, contractError: err.contractError ?? null, onChain: true });
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Evidence files are limited to 5 MB" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body" });
    // never echo request bodies: they can contain report text or nonces
    console.error(`[server] ${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 300)}`);
    res.status(500).json({ error: "Internal error: " + String(err?.message ?? err).slice(0, 300) });
  });

  return { app, lab, demo, shutdown: () => benchProc?.kill("SIGTERM") };
}
