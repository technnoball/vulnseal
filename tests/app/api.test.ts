// Application-level tests through the real HTTP API, backed by a real local chain.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { client, startEnv, type Env } from "./env.ts";
import { seed } from "../../scripts/seed.ts";
import { TamperLab } from "../../server/lab.ts";
import { Ledger } from "../../server/chain.ts";
import { PatchLedgerService } from "../../server/service.ts";

let env: Env;
let api: ReturnType<typeof client>;
let device = "";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const pdf = Buffer.from("%PDF-1.4\n% synthetic test invoice\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

describe("PatchLedger API", () => {
  before(async () => {
    env = await startEnv();
    api = client(env.base);
  });
  after(async () => {
    await env?.stop();
  });

  it("reports health of API and chain", async () => {
    const r = await api.get("/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.chain.ok, true);
  });

  it("registers a device as registrar and retrieves it; rejects other roles on-chain", async () => {
    const r = await api.post("/api/devices", "registrar", { brand: "Lenovo", model: "ThinkPad X270", year: 2017 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    device = r.body.publicId;
    assert.match(device, /^PL-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const p = await api.get(`/api/devices/${device}`);
    assert.equal(p.status, 200);
    assert.equal(p.body.device.model, "ThinkPad X270");
    assert.equal(p.body.events.length, 1);
    assert.equal(p.body.events[0].anchor, "anchored");

    const bad = await api.post("/api/devices", "buyer", { brand: "X", model: "Y" });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.contractError.name, "NotAuthorized");
    const noActor = await api.post("/api/devices", undefined, { brand: "X", model: "Y" });
    assert.equal(noActor.status, 401);
    const invalid = await api.post("/api/devices", "registrar", { brand: "", model: "Y" });
    assert.equal(invalid.status, 422);
  });

  it("serves a QR code that links to the verification page", async () => {
    const r = await fetch(`${env.base}/api/devices/${device}/qr.svg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /svg/);
    assert.match(await r.text(), /<svg/);
  });

  let evidenceId = "";
  it("uploads evidence, stores it locally and records its SHA-256", async () => {
    const r = await api.upload(`/api/devices/${device}/evidence`, "repairer-a", { name: "invoice.pdf", type: "application/pdf", data: pdf }, { kind: "repair-invoice", description: "test invoice" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    evidenceId = r.body.evidence.id;
    assert.equal(r.body.evidence.sha256, sha(pdf));
    const stored = fs.readdirSync(path.join(env.dataDir, "evidence"));
    assert.ok(stored.some((f) => f.startsWith(evidenceId)));
    const bad = await api.upload(`/api/devices/${device}/evidence`, "repairer-a", { name: "x.exe", type: "application/x-msdownload", data: Buffer.from("MZ") });
    assert.equal(bad.status, 415);
  });

  let repairSeq = -1;
  it("creates a repair event with committed evidence and shows it in the history", async () => {
    const r = await api.post(`/api/devices/${device}/events`, "repairer-a", {
      type: "REPAIR",
      claimedAt: "2025-01-10",
      category: "keyboard",
      component: "keyboard",
      description: "Replaced keyboard membrane",
      result: "repaired",
      evidenceIds: [evidenceId],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    repairSeq = r.body.seq;
    const p = await api.get(`/api/devices/${device}`, "repairer-a");
    const e = p.body.events[repairSeq];
    assert.equal(e.type, "REPAIR");
    assert.equal(e.category, "evidence-attached");
    assert.equal(e.anchor, "anchored");
    assert.equal(e.evidence[0].sha256, sha(pdf));
    assert.equal(e.payload.evidence[0].sha256, sha(pdf), "evidence digest is part of the committed payload");
    // evidence cannot be committed twice
    const again = await api.post(`/api/devices/${device}/events`, "repairer-a", { type: "REPAIR", category: "general", description: "x", result: "pass", evidenceIds: [evidenceId] });
    assert.equal(again.status, 409);
    // validation errors are helpful
    const invalid = await api.post(`/api/devices/${device}/events`, "repairer-a", { type: "REPAIR", category: "general", result: "pass" });
    assert.equal(invalid.status, 422);
    assert.match(invalid.body.error, /Description is required/);
  });

  it("verifies evidence integrity and detects an altered file", async () => {
    const ok = await api.post(`/api/evidence/${evidenceId}/verify`, "auditor");
    assert.equal(ok.body.file.status, "match");
    assert.equal(ok.body.commitment.onChainPayloadMatches, true);
    const lab = new TamperLab(env.svc);
    lab.alterEvidence(evidenceId, "file");
    const bad = await api.post(`/api/evidence/${evidenceId}/verify`, "auditor");
    assert.equal(bad.body.file.status, "mismatch");
    const integ = await api.get(`/api/devices/${device}/integrity`);
    assert.equal(integ.body.ok, false);
    assert.ok(integ.body.findings.some((f: any) => f.code === "EVIDENCE_FILE_ALTERED"));
    const passport = await api.get(`/api/devices/${device}`);
    assert.equal(passport.body.events[repairSeq].category, "evidence-failed");
    lab.restoreAll();
    assert.equal((await api.get(`/api/devices/${device}/integrity`)).body.ok, true);
  });

  it("restricts evidence contents by identity but always exposes the digest", async () => {
    const asBuyer = await api.get(`/api/evidence/${evidenceId}`, "buyer");
    assert.equal(asBuyer.body.canViewContent, false);
    assert.equal(asBuyer.body.sha256, sha(pdf));
    assert.equal((await fetch(`${env.base}/api/evidence/${evidenceId}/file?as=buyer`)).status, 403);
    const asAuditor = await fetch(`${env.base}/api/evidence/${evidenceId}/file?as=auditor`);
    assert.equal(asAuditor.status, 200);
    assert.equal(sha(Buffer.from(await asAuditor.arrayBuffer())), sha(pdf));
  });

  let challengeSeq = -1;
  it("accepts a buyer challenge, rejects self-challenge and keeps the claim visible", async () => {
    const self = await api.post(`/api/devices/${device}/events`, "repairer-a", { type: "CHALLENGE", refSeq: repairSeq, reason: "I challenge myself" });
    assert.equal(self.status, 403);
    assert.equal(self.body.contractError.name, "SelfChallenge");
    const r = await api.post(`/api/devices/${device}/events`, "buyer", { type: "CHALLENGE", refSeq: repairSeq, reason: "Keyboard still faulty on delivery" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    challengeSeq = r.body.seq;
    const p = await api.get(`/api/devices/${device}`);
    assert.equal(p.body.openDisputes, 1);
    assert.equal(p.body.events[repairSeq].category, "disputed");
    const d = await api.get("/api/disputes");
    assert.ok(d.body.some((x: any) => x.publicId === device && x.status === "open"));
  });

  it("rejects unauthorized resolutions and accepts an independent auditor; history is preserved", async () => {
    const before = (await api.get(`/api/devices/${device}`)).body.events;
    for (const actor of ["buyer", "repairer-a", "inspector", "outsider"]) {
      const r = await api.post(`/api/devices/${device}/events`, actor, { type: "RESOLUTION", refSeq: challengeSeq, outcome: "CLAIM_UPHELD", reason: "not allowed" });
      assert.equal(r.status, 403, `${actor} must not resolve`);
      assert.equal(r.body.onChain, true);
    }
    const ok = await api.post(`/api/devices/${device}/events`, "auditor", { type: "RESOLUTION", refSeq: challengeSeq, outcome: "CLAIM_REJECTED", reason: "Membrane part number does not match invoice" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const after = (await api.get(`/api/devices/${device}`)).body;
    assert.equal(after.openDisputes, 0);
    assert.equal(after.events.length, before.length + 1);
    assert.deepEqual(after.events[repairSeq].payload, before[repairSeq].payload, "the disputed claim is unchanged");
    assert.equal(after.events[repairSeq].recordHash, before[repairSeq].recordHash);
    assert.equal(after.events[challengeSeq].type, "CHALLENGE");
    assert.equal(after.events[ok.body.seq].outcome, "CLAIM_REJECTED");
    assert.ok(after.events[repairSeq].flags.some((f: string) => /judged this claim inaccurate/.test(f)));
  });

  it("appends corrections without altering the original and rejects stale predecessors", async () => {
    const before = (await api.get(`/api/devices/${device}`)).body;
    const stale = await api.post(`/api/devices/${device}/events`, "repairer-a", {
      type: "CORRECTION", refSeq: repairSeq, reason: "typo", description: "x", expectedPrevHash: before.events[0].recordHash,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.contractError.name, "StalePrevHash");
    const r = await api.post(`/api/devices/${device}/events`, "repairer-a", {
      type: "CORRECTION", refSeq: repairSeq, reason: "Wrong component named", description: "Replaced keyboard and trackpad cable", expectedPrevHash: before.onChainHeadHash,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = (await api.get(`/api/devices/${device}`)).body;
    assert.equal(p.events[repairSeq].payload.description, "Replaced keyboard membrane");
    assert.equal(p.events[repairSeq].supersededBySeq, r.body.seq);
  });

  it("exports a JSON history that verifies independently, and a verification report", async () => {
    const x = await api.get(`/api/devices/${device}/export`);
    assert.equal(x.status, 200);
    assert.match(x.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(x.body.format, "patchledger.export.v1");
    assert.equal(x.body.records.length, x.body.verification.chain.onChainRecords);
    const file = path.join(env.dataDir, "export.json");
    fs.writeFileSync(file, JSON.stringify(x.body));
    const out = execFileSync(process.execPath, ["scripts/verify-export.ts", file, "--rpc", env.chain.url, "--evidence-dir", path.join(env.dataDir, "evidence")], { encoding: "utf8" });
    assert.match(out, /PASS/);
    // a tampered export fails
    x.body.records[1].canonicalPayload = x.body.records[1].canonicalPayload.replace("membrane", "assembly");
    fs.writeFileSync(file, JSON.stringify(x.body));
    assert.throws(() => execFileSync(process.execPath, ["scripts/verify-export.ts", file], { encoding: "utf8", stdio: "pipe" }));
    const rep = await api.get(`/api/devices/${device}/report`);
    assert.equal(rep.status, 200);
    assert.match(rep.body, /Verdict: PASS/);
    assert.match(rep.body, /Evidence digests/);
  });

  it("detects mismatches between the database and on-chain commitments", async () => {
    const lab = new TamperLab(env.svc);
    lab.editRecord(device, repairSeq);
    let r = (await api.get(`/api/devices/${device}/integrity`)).body;
    assert.ok(r.findings.some((f: any) => f.code === "PAYLOAD_DIGEST_MISMATCH" && f.seq === repairSeq));
    lab.restoreAll();
    lab.deleteRecord(device, 1);
    r = (await api.get(`/api/devices/${device}/integrity`)).body;
    assert.ok(r.findings.some((f: any) => f.code === "OFFCHAIN_RECORD_MISSING"));
    lab.restoreAll();
    lab.alterEvidence(evidenceId, "file-and-db");
    r = (await api.get(`/api/devices/${device}/integrity`)).body;
    assert.ok(r.findings.some((f: any) => f.code === "EVIDENCE_DIGEST_EDITED"));
    lab.restoreAll();
    // a row inserted directly into the database has no on-chain commitment
    const rows = env.svc.store.listEvents(device);
    env.svc.store.insertEvent({ ...rows[rows.length - 1], seq: rows.length });
    r = (await api.get(`/api/devices/${device}/integrity`)).body;
    assert.ok(r.findings.some((f: any) => f.code === "UNANCHORED_RECORD"));
    env.svc.store.db.prepare("DELETE FROM events WHERE public_id=? AND seq=?").run(device, rows.length);
    assert.equal((await api.get(`/api/devices/${device}/integrity`)).body.ok, true);
  });

  it("rejects on-chain rewrite attempts through the tamper lab", async () => {
    const r = await api.post("/api/lab/chain-attempts", "registrar", { publicId: device, seq: 1 });
    assert.equal(r.status, 200);
    assert.ok(r.body.attempts.every((a: any) => a.rejected));
    assert.equal(r.body.recordUnchanged, true);
    assert.equal(r.body.recordCountBefore, r.body.recordCountAfter);
  });

  it("seeds the synthetic demo with conflicts, an open dispute and an evidence-reuse warning", async () => {
    const ids = await seed(env.svc);
    const disputed = await api.get(`/api/devices/${ids.disputed}`);
    assert.equal(disputed.body.openDisputes, 1);
    assert.ok(disputed.body.conflicts.some((c: any) => c.component === "battery" && c.status === "open"));
    assert.ok(disputed.body.events.some((e: any) => e.evidence.some((v: any) => v.reusedElsewhere.length > 0)));
    const battery = await api.get(`/api/devices/${ids.batteryReplacement}`);
    assert.equal(battery.body.events[2].category, "corroborated");
    const straight = await api.get(`/api/devices/${ids.straightforward}`);
    assert.equal(straight.body.events[1].category, "superseded");
    const pub = await api.get(`/api/public/devices/${ids.disputed}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.integrity.ok, true);
    const text = JSON.stringify(pub.body);
    assert.ok(!text.includes("description") && !text.includes("filename"), "public view omits free text and filenames");
    const dash = await api.get("/api/dashboard");
    assert.ok(dash.body.totals.devices >= 5);
    assert.ok(dash.body.totals.openDisputes >= 1);
    assert.equal((await api.get("/api/integrity")).body.ok, true);
  });

  it("returns a helpful 503 when the blockchain is unavailable", async () => {
    const dead = new Ledger("http://127.0.0.1:1", env.svc.ledger.address);
    const svc = new PatchLedgerService(env.svc.store, dead, env.svc.vault);
    await assert.rejects(svc.registerDevice("registrar", { brand: "A", model: "B" }), (e: any) => e.status === 503 && /Local blockchain unavailable/.test(e.message));
    const p = await svc.getPassport(device);
    assert.match(p.chainError ?? "", /unavailable/);
    dead.provider.destroy();
  });
});
