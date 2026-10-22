// HTTP API and static frontend. Demo identity is selected with the
// X-Demo-Actor header — a demonstration convenience, NOT authentication.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import QRCode from "qrcode";
import { LedgerError } from "./chain.ts";
import { ROOT, type AppConfig } from "./config.ts";
import { COMPONENTS, EVIDENCE_KINDS, IDENTITIES, RECORD_TYPE_LABEL } from "./domain.ts";
import { MAX_EVIDENCE_BYTES } from "./evidence.ts";
import { TamperLab } from "./lab.ts";
import { CATEGORIES, CATEGORY_LABEL, FORM_FACTORS, PART_ORIGINS, PatchLedgerService, RESULTS, ServiceError } from "./service.ts";

const actorOf = (req: Request) => (req.header("x-demo-actor") ?? undefined) || undefined;
const seqParam = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ServiceError("seq must be a non-negative integer", 422);
  return n;
};

interface BenchState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  params: { devices: number; events: number; seed: number } | null;
  log: string;
}

export function createApp(svc: PatchLedgerService, cfg: AppConfig) {
  const app = express();
  const lab = new TamperLab(svc);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } });
  const bench: BenchState = { running: false, startedAt: null, finishedAt: null, exitCode: null, params: null, log: "" };
  let benchProc: ChildProcess | null = null;

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });
  app.use(express.json({ limit: "256kb" }));

  const api = express.Router();

  api.get("/health", async (_req, res) => {
    try {
      const p = await svc.ledger.ping();
      res.json({ ok: true, api: "up", chain: { ok: true, ...p, contract: svc.ledger.address, chainId: svc.ledger.chainId, rpcUrl: svc.ledger.rpcUrl } });
    } catch (e) {
      res.status(503).json({ ok: false, api: "up", chain: { ok: false, error: (e as Error).message, rpcUrl: svc.ledger.rpcUrl } });
    }
  });

  api.get("/meta", (_req, res) => {
    res.json({
      identities: IDENTITIES.map((i) => ({ ...i, address: svc.ledger.addressOf(i.id) })),
      recordTypes: RECORD_TYPE_LABEL,
      categories: CATEGORIES,
      results: RESULTS,
      components: COMPONENTS,
      partOrigins: PART_ORIGINS,
      formFactors: FORM_FACTORS,
      evidenceKinds: EVIDENCE_KINDS,
      evidenceCategories: CATEGORY_LABEL,
      demoLab: cfg.demoLab,
      publicBaseUrl: cfg.publicBaseUrl,
    });
  });

  api.get("/identities", async (_req, res) => res.json(await svc.identities()));
  api.get("/dashboard", async (_req, res) => res.json(await svc.dashboard()));
  api.get("/devices", (_req, res) => res.json(svc.listDevices()));
  api.post("/devices", async (req, res) => res.status(201).json(await svc.registerDevice(actorOf(req), req.body ?? {})));
  api.get("/devices/:id", async (req, res) => res.json(await svc.getPassport(req.params.id, actorOf(req))));
  api.get("/devices/:id/qr.svg", async (req, res) => {
    svc.store.getDevice(req.params.id) ?? (() => { throw new ServiceError("Device not found", 404); })();
    const url = `${cfg.publicBaseUrl}/verify/${encodeURIComponent(req.params.id)}`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#332A26", light: "#E9E1D2" } });
    res.type("image/svg+xml").send(svg);
  });
  api.post("/devices/:id/evidence", upload.single("file"), (req, res) => {
    const f = req.file;
    res.status(201).json(
      svc.uploadEvidence(actorOf(req), String(req.params.id), f ? { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype } : undefined, req.body ?? {}),
    );
  });
  api.post("/devices/:id/events", async (req, res) => res.status(201).json(await svc.appendEvent(actorOf(req), req.params.id, req.body ?? {})));
  api.get("/devices/:id/integrity", async (req, res) => res.json(await svc.checkIntegrity(req.params.id)));
  api.get("/devices/:id/export", async (req, res) => {
    const x = await svc.exportHistory(req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="patchledger-${req.params.id}-history.json"`);
    res.type("application/json").send(JSON.stringify(x, null, 2));
  });
  api.get("/devices/:id/report", async (req, res) => {
    const md = await svc.verificationReport(req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="patchledger-${req.params.id}-verification.md"`);
    res.type("text/markdown").send(md);
  });

  api.get("/public/devices/:id", async (req, res) => res.json(await svc.getPublicView(req.params.id)));

  api.get("/evidence/:id", (req, res) => res.json(svc.getEvidenceDetail(req.params.id, actorOf(req))));
  api.get("/evidence/:id/file", (req, res) => {
    // identity can come from a query parameter so <img>/<iframe> can load it
    const viewer = actorOf(req) ?? (typeof req.query.as === "string" ? req.query.as : undefined);
    const f = svc.evidenceFile(req.params.id, viewer);
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${f.filename.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "no-store");
    // user-supplied SVG/text must never run script in our origin
    if (f.mime === "image/svg+xml" || f.mime.startsWith("text/")) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.sendFile(f.path);
  });
  api.post("/evidence/:id/verify", async (req, res) => res.json(await svc.verifyEvidenceOnChain(req.params.id)));

  api.get("/disputes", async (_req, res) => res.json(await svc.disputes()));
  api.get("/integrity", async (_req, res) => res.json(await svc.checkAll()));

  // --- tamper lab (attack simulation) -------------------------------------
  const labGuard = (_req: Request, _res: Response, next: NextFunction) => {
    if (!cfg.demoLab) throw new ServiceError("The tamper lab is disabled (PL_DEMO_LAB=0)", 403);
    next();
  };
  api.get("/lab/state", labGuard, (_req, res) => res.json(lab.state()));
  api.post("/lab/edit-record", labGuard, (req, res) => res.json(lab.editRecord(String(req.body.publicId), seqParam(req.body.seq))));
  api.post("/lab/delete-record", labGuard, (req, res) => res.json(lab.deleteRecord(String(req.body.publicId), seqParam(req.body.seq))));
  api.post("/lab/alter-evidence", labGuard, (req, res) =>
    res.json(lab.alterEvidence(String(req.body.evidenceId), req.body.mode === "file-and-db" ? "file-and-db" : "file")),
  );
  api.post("/lab/restore", labGuard, (_req, res) => res.json(lab.restoreAll()));
  api.post("/lab/chain-attempts", labGuard, async (req, res) => {
    const actor = actorOf(req);
    if (!actor) throw new ServiceError("Select a demonstration identity first", 401);
    res.json(await lab.chainAttempts(actor, String(req.body.publicId), seqParam(req.body.seq)));
  });

  // --- benchmark ------------------------------------------------------------
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
    const devices = Number(req.body?.devices ?? 10);
    const events = Number(req.body?.events ?? 8);
    const seed = Number(req.body?.seed ?? 42);
    for (const [k, v, max] of [["devices", devices, 200], ["events", events, 60], ["seed", seed, 2 ** 31]] as const) {
      if (!Number.isInteger(v) || v < 1 || v > max) throw new ServiceError(`${k} must be an integer between 1 and ${max}`, 422);
    }
    if (devices * events > 3000) throw new ServiceError("devices × events is limited to 3000 from the UI; use the CLI for larger runs", 422);
    Object.assign(bench, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, params: { devices, events, seed }, log: "" });
    benchProc = spawn(process.execPath, ["scripts/benchmark.ts", "--devices", String(devices), "--events", String(events), "--seed", String(seed), "--out", cfg.resultsDir], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (d: Buffer) => {
      bench.log = (bench.log + d.toString()).slice(-8000);
    };
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

  // --- static frontend --------------------------------------------------------
  if (fs.existsSync(path.join(cfg.webDist, "index.html"))) {
    app.use(express.static(cfg.webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'",
      );
      res.sendFile(path.join(cfg.webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => res.type("text").send("PatchLedger API is running. Frontend not built: run npm run build:web"));
  }

  // --- errors -----------------------------------------------------------------
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof LedgerError) return res.status(err.status).json({ error: err.message, contractError: err.contractError ?? null, onChain: true });
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Evidence files are limited to 10 MB" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body" });
    console.error(err);
    res.status(500).json({ error: "Internal error: " + String(err?.message ?? err) });
  });

  const shutdown = () => benchProc?.kill("SIGTERM");
  return { app, lab, shutdown };
}
