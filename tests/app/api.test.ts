// Backend and API-workflow tests: real chain, real Express app, cookie sessions.
// Each test drives the same HTTP endpoints the frontend uses.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { client, REPORT, startEnv, type Env } from "./env.ts";
import { seedDemo } from "../../scripts/seed.ts";

let env: Env;
type C = Awaited<ReturnType<typeof client>>;
let as: Record<string, C> = {};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("VulnSeal API", () => {
  before(async () => {
    env = await startEnv();
    for (const id of ["basalt", "quillfox", "nightjar", "ashgrove-triage", "ashgrove-admin", "kestrel-triage", "kestrel-admin", "tamarind-triage", "arb-holm", "arb-okafor", "arb-vance", "arb-sato", "arb-reyes", "auditor", "outsider"]) {
      as[id] = await client(env.base, id);
    }
    as.anonymous = await client(env.base);
  });
  after(async () => {
    await env?.stop();
  });

  let cid = 0;
  let receipt: any;
  let pkg: any;

  it("serves health and requires a (simulated) session for protected routes", async () => {
    assert.equal((await as.anonymous.get("/api/health")).body.ok, true);
    const r = await as.anonymous.get("/api/me/reports");
    assert.equal(r.status, 401);
    assert.match(r.body.error, /simulated sign-in/);
    assert.equal((await as.anonymous.post("/api/session", { identityId: "nobody" })).status, 422);
    const forged = await fetch(`${env.base}/api/me/reports`, { headers: { Cookie: "vs_session=basalt.123.forgedsignature" } });
    assert.equal(forged.status, 401, "a session cookie with a bad HMAC is rejected");
  });

  it("creates and persists a synthetic report; only the commitment goes on-chain", async () => {
    const r = await as.basalt.post("/api/reports", { ...REPORT, programId: 1, privateNotes: "only for me" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cid = r.body.cid;
    receipt = r.body.receipt;
    assert.match(r.body.commitment, /^0x[0-9a-f]{64}$/);
    const mine = await as.basalt.get("/api/me/reports");
    assert.ok(mine.body.reports.some((x: any) => x.cid === cid && x.title === REPORT.title));
    const own = await as.basalt.get(`/api/reports/${cid}`);
    assert.equal(own.body.content.privateNotes, "only for me");
    // the database never holds the report in plaintext, and the chain holds only the hash
    env.svc.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.ok(!fs.readFileSync(path.join(env.dataDir, "vulnseal.sqlite")).toString("latin1").includes(REPORT.title));
    const c = await env.svc.commitmentOnChain(cid);
    assert.equal(c.commitment, r.body.commitment);
  });

  it("issues a downloadable receipt without the nonce, verifiable against the chain", async () => {
    const dl = await as.basalt.raw(`/api/reports/${cid}/receipt`);
    assert.match(dl.headers.get("content-disposition") ?? "", /attachment; filename="vulnseal-receipt-VS-/);
    const body = await dl.json();
    assert.equal(body.commitment, receipt.commitment);
    assert.ok(!JSON.stringify(body).includes("nonce"));
    const v = await as.anonymous.post("/api/verify/receipt", { receipt: body });
    assert.equal(v.body.verdict, "valid", JSON.stringify(v.body.checks.filter((c: any) => !c.ok)));
    const backdated = await as.anonymous.post("/api/verify/receipt", { receipt: { ...body, anchoredAt: body.anchoredAt - 3600 } });
    assert.equal(backdated.body.verdict, "invalid");
    const { txHash: _drop, ...partial } = body;
    assert.equal((await as.anonymous.post("/api/verify/receipt", { receipt: partial })).body.verdict, "incomplete");
    pkg = (await as.basalt.get(`/api/reports/${cid}/recovery`)).body;
    assert.match(pkg.nonce, /^0x[0-9a-f]{64}$/);
  });

  it("blocks ID-based access to another party's confidential report", async () => {
    for (const who of ["quillfox", "kestrel-triage", "auditor", "outsider", "arb-holm"]) {
      const r = await as[who].get(`/api/reports/${cid}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.access.allowed, false, `${who} must not read the content`);
      assert.equal(r.body.content, null);
    }
    assert.equal((await as.quillfox.get(`/api/reports/${cid}/recovery`)).status, 403);
    assert.equal((await as["kestrel-admin"].get(`/api/reports/${cid}/receipt`)).status, 403);
    assert.equal((await as.quillfox.post(`/api/reports/${cid}/reveal`, { mode: "vault" })).status, 403);
    // even Ashgrove (the receiving program) sees nothing before the reveal
    assert.equal((await as["ashgrove-triage"].get(`/api/reports/${cid}`)).body.access.allowed, false);
    const log = await as.auditor.get("/api/access-log");
    assert.ok(log.body.some((e: any) => e.identity_id === "quillfox" && e.allowed === 0));
  });

  it("refuses a premature reveal, then processes matching, altered, incomplete and malformed reveals", async () => {
    const early = await as.basalt.post(`/api/reports/${cid}/reveal`, { mode: "vault" });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /not requested a reveal/);
    assert.equal((await as["kestrel-triage"].post(`/api/reports/${cid}/acknowledge`)).status, 403, "wrong program is rejected on-chain");
    assert.equal((await as["ashgrove-triage"].post(`/api/reports/${cid}/acknowledge`)).status, 200);
    assert.equal((await as["ashgrove-triage"].post(`/api/reports/${cid}/request-reveal`)).status, 200);

    const altered = await as.basalt.post(`/api/reports/${cid}/reveal`, { mode: "edited", edits: { impact: "Much worse than committed." } });
    assert.equal(altered.body.precheck.outcome, "mismatch");
    assert.equal(altered.body.precheck.contractAgrees, true, "the contract's verifyOpening agrees (eth_call)");
    const v1 = await as["ashgrove-triage"].post(`/api/reveals/${altered.body.revealId}/verify`);
    assert.equal(v1.body.outcome, "mismatch");
    assert.equal((await env.svc.commitmentOnChain(cid)).mismatches, 1);

    const { nonce: _n, ...noNonce } = pkg;
    const missing = await as.basalt.post(`/api/reports/${cid}/reveal`, { mode: "package", package: noNonce });
    assert.equal(missing.body.precheck.outcome, "missing");
    const malformed = await as.basalt.post(`/api/reports/${cid}/reveal`, { mode: "package", package: "{not json" });
    assert.equal(malformed.body.precheck.outcome, "invalid-encoding");

    const good = await as.basalt.post(`/api/reports/${cid}/reveal`, { mode: "package", package: pkg });
    assert.equal(good.body.precheck.outcome, "match");
    const v2 = await as["ashgrove-triage"].post(`/api/reveals/${good.body.revealId}/verify`);
    assert.equal(v2.body.outcome, "match");
    const c = await env.svc.commitmentOnChain(cid);
    assert.equal(c.status, 4, "revealed");
    assert.equal(c.mismatches, 1, "the earlier mismatch stays on record");
    const view = await as["ashgrove-triage"].get(`/api/reports/${cid}`);
    assert.equal(view.body.content.title, REPORT.title);
    assert.equal(view.body.content.privateNotes, undefined, "private notes are never revealed");
  });

  let other = 0;
  let aid = 0;
  it("runs the cross-program association workflow with independent review", async () => {
    const r = await as.quillfox.post("/api/reports", { ...REPORT, title: "Synthetic overlapping finding", programId: 2 });
    other = r.body.cid;
    await as["kestrel-triage"].post(`/api/reports/${other}/acknowledge`);
    await as["kestrel-triage"].post(`/api/reports/${other}/request-reveal`);
    const rv = await as.quillfox.post(`/api/reports/${other}/reveal`, { mode: "vault" });
    await as["kestrel-triage"].post(`/api/reveals/${rv.body.revealId}/verify`);
    // Kestrel cannot read Ashgrove's report until disclosure is granted on-chain
    assert.equal((await as["kestrel-triage"].get(`/api/reports/${cid}`)).body.access.allowed, false);
    assert.equal((await as.basalt.post(`/api/reports/${cid}/grant`, { toProgram: 2 })).status, 200);
    const granted = await as["kestrel-triage"].get(`/api/reports/${cid}`);
    assert.equal(granted.body.access.scope, "disclosed");
    assert.equal((await as["tamarind-triage"].get(`/api/reports/${cid}`)).body.access.allowed, false, "only the granted program");

    const p = await as["ashgrove-triage"].post("/api/associations", { cidA: cid, cidB: other, relation: 1, rationale: "Same export component and fix." });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    aid = p.body.aid;
    const self = await as["ashgrove-admin"].post(`/api/associations/${aid}/review`, { approve: true, rationale: "self" });
    assert.equal(self.status, 403);
    assert.equal(self.body.contractError.name, "WrongProgram");
    assert.equal((await as["kestrel-triage"].post(`/api/associations/${aid}/review`, { approve: true, rationale: "Confirmed after reading both." })).status, 200);
    const a = await as["kestrel-triage"].get(`/api/associations/${aid}`);
    assert.equal(a.body.statusName, "confirmed");
    assert.match(a.body.family, /^0x[0-9a-f]{64}$/);
    assert.equal(a.body.rationale, "Same export component and fix.");
    assert.equal((await as.auditor.get(`/api/associations/${aid}`)).body.rationale, null, "auditors see the digest, not the rationale");
  });

  let did = 0;
  it("records disputes, rejects unauthorized adjudication, and keeps both rounds after an appeal", async () => {
    const d = await as.quillfox.post("/api/disputes", { kind: 2, subject: aid, statement: "My report reproduced the issue on the console as well." });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    did = d.body.did;
    assert.equal((await as.nightjar.post("/api/disputes", { kind: 2, subject: aid, statement: "x" })).status, 409, "one live dispute per subject");
    for (const [who, err] of [["kestrel-admin", "NotAuthorized"], ["arb-reyes", "ConflictedArbitrator"], ["outsider", "NotAuthorized"]] as const) {
      const r = await as[who].post(`/api/disputes/${did}/vote`, { decision: 6, reasonCode: 110, rationale: "x" });
      assert.equal(r.status, 403, who);
      assert.equal(r.body.contractError.name, err);
    }
    assert.equal((await as["arb-holm"].post(`/api/disputes/${did}/vote`, { decision: 5, reasonCode: 999, rationale: "x" })).status, 422);
    await as["arb-holm"].post(`/api/disputes/${did}/vote`, { decision: 5, reasonCode: 100, rationale: "Earlier matching commitment." });
    assert.equal((await as["arb-holm"].post(`/api/disputes/${did}/vote`, { decision: 5, reasonCode: 100, rationale: "again" })).body.contractError.name, "AlreadyVoted");
    await as["arb-okafor"].post(`/api/disputes/${did}/vote`, { decision: 5, reasonCode: 100, rationale: "Agree." });
    let view = await as.quillfox.get(`/api/disputes/${did}`);
    assert.equal(view.body.statusName, "decided");
    assert.equal(view.body.appealOpen, true);
    assert.equal((await as.quillfox.post(`/api/disputes/${did}/appeal`, { statement: "The first report missed the console." })).status, 200);
    assert.equal((await as["arb-holm"].post(`/api/disputes/${did}/vote`, { decision: 7, reasonCode: 110, rationale: "x" })).body.contractError.name, "PriorPanelMember");
    await as["arb-vance"].post(`/api/disputes/${did}/vote`, { decision: 7, reasonCode: 110, rationale: "Shared." });
    await as["arb-sato"].post(`/api/disputes/${did}/vote`, { decision: 7, reasonCode: 110, rationale: "Shared." });
    view = await as.quillfox.get(`/api/disputes/${did}`);
    assert.equal(view.body.statusName, "final");
    assert.equal(view.body.firstDecision, 5, "round-1 decision preserved");
    assert.equal(view.body.decision, 7);
    assert.equal(view.body.reversed, true);
    assert.equal(view.body.acts.filter((a: any) => a.act === "vote").length, 4);
    assert.ok(view.body.acts.every((a: any) => a.act !== "vote" || a.rationale), "parties read rationales");
    const outsiderView = await as.nightjar.get(`/api/disputes/${did}`);
    assert.equal(outsiderView.body.statement, null, "non-parties do not see statements");
    assert.ok(view.body.policy.digest.startsWith("0x"));
  });

  it("stores evidence encrypted and serves it only to authorised readers", async () => {
    const data = Buffer.from("SYNTHETIC evidence: fictional request log\n");
    const up = await as.nightjar.upload("/api/evidence", { name: "log.txt", type: "text/plain", data });
    assert.equal(up.status, 201);
    assert.equal(up.body.sha256, sha(data));
    const stored = fs.readdirSync(path.join(env.dataDir, "evidence"));
    assert.ok(stored.every((f) => !fs.readFileSync(path.join(env.dataDir, "evidence", f)).toString("latin1").includes("fictional request log")), "evidence is encrypted at rest");
    const r = await as.nightjar.post("/api/reports", { ...REPORT, title: "Synthetic with evidence", programId: 3, evidenceIds: [up.body.id] });
    assert.equal(r.status, 201);
    const file = await as.nightjar.raw(`/api/evidence/${up.body.id}`);
    assert.equal(sha(Buffer.from(await file.arrayBuffer())), sha(data));
    assert.equal((await as.basalt.raw(`/api/evidence/${up.body.id}`)).status, 403);
    assert.equal((await as["tamarind-triage"].raw(`/api/evidence/${up.body.id}`)).status, 403, "not before reveal");
    const reuse = await as.basalt.post("/api/reports", { ...REPORT, programId: 1, evidenceIds: [up.body.id] });
    assert.equal(reuse.status, 403, "evidence belongs to its uploader");
    const bad = await as.nightjar.upload("/api/evidence", { name: "x.exe", type: "application/x-msdownload", data: Buffer.from("MZ") });
    assert.equal(bad.status, 415);
  });

  it("rejects missing and malformed input with helpful errors", async () => {
    const missing = await as.basalt.post("/api/reports", { programId: 1, severity: "low" });
    assert.equal(missing.status, 422);
    assert.match(missing.body.error, /Title is required/);
    assert.equal((await as.basalt.post("/api/reports", { ...REPORT, programId: 9 })).status, 422);
    assert.equal((await as.basalt.post("/api/reports", { ...REPORT, programId: 1, severity: "apocalyptic" })).status, 422);
    assert.equal((await as.basalt.get("/api/reports/abc")).status, 422);
    assert.equal((await as.basalt.get("/api/reports/99999")).status, 404);
    const bad = await fetch(`${env.base}/api/verify/receipt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(bad.status, 400);
    assert.equal((await as["ashgrove-admin"].post("/api/reports", { ...REPORT, programId: 1 })).body.contractError.name, "NotAuthorized", "program admins cannot commit reports");
  });

  it("preserves the original when a researcher revises a report", async () => {
    const r = await as.basalt.post(`/api/reports/${cid}/revise`, { ...REPORT, title: "Revised synthetic finding" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const old = await env.svc.commitmentOnChain(cid);
    assert.equal(old.supersededBy, r.body.cid);
    assert.equal(old.commitment, receipt.commitment, "original commitment unchanged");
    assert.equal((await as.quillfox.post(`/api/reports/${r.body.cid}/revise`, { ...REPORT })).status, 403);
  });

  it("seeds the demo, shows real dashboard figures and exports a verifiable audit report", async () => {
    await seedDemo(env.svc);
    const dash = await as.anonymous.get("/api/dashboard");
    const snap = await env.svc.snapshot();
    assert.equal(dash.body.totals.commitments, snap.commitments.length);
    assert.equal(dash.body.totals.completedArbitrations, snap.disputes.filter((d) => d.status === 4).length);
    assert.equal(dash.body.totals.logEntries, Number(await env.svc.ledger.read("logCount")));
    assert.ok(dash.body.recent.length > 0);
    const audit = await as.auditor.get("/api/audit/report");
    assert.equal(audit.body.ok, true, JSON.stringify(audit.body.findings));
    assert.equal((await as.basalt.get("/api/audit/report")).status, 403);
    const exp = await as.auditor.raw("/api/audit/export");
    const file = path.join(env.dataDir, "audit.json");
    fs.writeFileSync(file, Buffer.from(await exp.arrayBuffer()));
    const out = execFileSync(process.execPath, ["scripts/verify-audit.ts", file, "--rpc", env.chain.url], { encoding: "utf8" });
    assert.match(out, /every entry hash and link recomputes/);
    assert.match(out, /matches/);
    const x = JSON.parse(fs.readFileSync(file, "utf8"));
    x.log[3].dataHash = "0x" + "00".repeat(32);
    fs.writeFileSync(file, JSON.stringify(x));
    assert.throws(() => execFileSync(process.execPath, ["scripts/verify-audit.ts", file], { stdio: "pipe" }), "a tampered export fails");
    const att = await as.auditor.post("/api/audit/attest");
    assert.match(att.body.tx, /^0x/);
  });

  it("detects off-chain tampering through the audit, and rejects on-chain rewrites", async () => {
    const lab = (p: string, b: unknown) => as.auditor.post(`/api/lab/${p}`, b);
    const reveal = env.svc.store.get("SELECT id FROM reveals WHERE outcome = 'match' LIMIT 1")!.id;
    assert.equal((await lab("alter-reveal", { revealId: reveal })).status, 200);
    assert.equal((await lab("alter-commitment", { cid })).status, 200);
    assert.equal((await lab("delete-event", { seq: 40 })).status, 200);
    assert.equal((await lab("alter-rationale", { aid })).status, 200);
    const ev = env.svc.store.get("SELECT id FROM evidence WHERE cid IS NOT NULL LIMIT 1")!.id;
    assert.equal((await lab("alter-evidence", { evidenceId: ev })).status, 200);
    const codes = new Set((await as.auditor.get("/api/audit/report")).body.findings.map((f: any) => f.code));
    for (const c of ["REVEAL_RECHECK_DIFFERS", "REPORT_COMMITMENT_MISMATCH", "MIRROR_EVENT_MISSING", "RATIONALE_ALTERED", "EVIDENCE_ALTERED"]) assert.ok(codes.has(c), `audit reports ${c}`);
    const attempts = await lab("chain-attempts", { cid: other });
    assert.ok(attempts.body.attempts.every((a: any) => a.rejected));
    assert.equal(attempts.body.unchanged, true);
    assert.equal((await as.basalt.post("/api/lab/restore")).status, 403, "the lab is auditor-only");
    await lab("restore", {});
    assert.equal((await as.auditor.get("/api/audit/report")).body.ok, true);
  });

  it("runs the guided demo scenario end to end with real transactions", async () => {
    let s: any;
    for (let i = 0; i < 14; i++) s = (await as.anonymous.post("/api/demo/step")).body;
    assert.equal(s.done, true, JSON.stringify(s).slice(0, 400));
    const expectedRejections = s.results.flatMap((r: any) => r.actions).filter((a: any) => a.expectedFailure).length;
    assert.equal(expectedRejections, 4, "self-review, conflicted vote, admin vote, prior-panel vote are rejected");
    assert.ok(s.results.flatMap((r: any) => r.actions).every((a: any) => a.ok || a.expectedFailure));
    const d = await as.nightjar.get(`/api/disputes/${s.did}`);
    assert.equal(d.body.statusName, "final");
  });
});
