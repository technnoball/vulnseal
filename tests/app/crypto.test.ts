// Unit tests for the commitment encoding, the vault, sessions and journal replay.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { REPORT_SCHEMA, REVEAL_FORMAT, checkReveal, computeCommitment, evidenceRoot, fieldsDigest, newNonce, noteDigest, type ReportFields } from "../../server/commitment.ts";
import { Vault } from "../../server/vault.ts";
import { Sessions } from "../../server/session.ts";
import { Journal, replay, syncClock } from "../../server/journal.ts";
import { makeProvider } from "../../server/chain.ts";
import { Keyring } from "../../server/keys.ts";
import { Store } from "../../server/db.ts";
import { startChain } from "../../scripts/lib/chainproc.ts";
import { initConsortium } from "../../scripts/lib/consortium.ts";

const report: ReportFields = { title: "t", description: "d", impact: "i", reproduction: "r", scope: "s", severity: "low", evidence: [] };
const ctx = { chainId: 31337, contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3", researcher: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", programId: 1, policyVersion: 1 };

describe("commitment encoding", () => {
  it("is field-separated: moving text between fields changes the digest (no concatenation collisions)", () => {
    const a = fieldsDigest({ ...report, title: "ab", description: "c" });
    const b = fieldsDigest({ ...report, title: "a", description: "bc" });
    assert.notEqual(a, b);
  });
  it("normalises Unicode and ignores evidence order", () => {
    assert.equal(fieldsDigest({ ...report, title: "é" }), fieldsDigest({ ...report, title: "é" }));
    const h1 = "aa".repeat(32), h2 = "bb".repeat(32);
    assert.equal(evidenceRoot([h1, h2]), evidenceRoot([h2, "0x" + h1.toUpperCase()]));
  });
  it("hides content behind a fresh 256-bit nonce and binds researcher, program and policy", () => {
    const d = fieldsDigest(report);
    const n1 = newNonce(), n2 = newNonce();
    assert.notEqual(n1, n2);
    assert.notEqual(computeCommitment(ctx, d, n1), computeCommitment(ctx, d, n2));
    const c = computeCommitment(ctx, d, n1);
    assert.notEqual(c, computeCommitment({ ...ctx, researcher: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }, d, n1));
    assert.notEqual(c, computeCommitment({ ...ctx, programId: 2 }, d, n1));
    assert.notEqual(c, computeCommitment({ ...ctx, policyVersion: 2 }, d, n1));
    assert.notEqual(c, computeCommitment({ ...ctx, chainId: 1 }, d, n1));
  });
  it("classifies reveals as match, mismatch, missing or invalid encoding", () => {
    const nonce = newNonce();
    const commitment = computeCommitment(ctx, fieldsDigest(report), nonce);
    const anchored = { cid: 1, commitment, ...ctx };
    const pkg = { format: REVEAL_FORMAT, commitmentId: 1, ...ctx, report: { schema: REPORT_SCHEMA, ...report }, nonce };
    assert.equal(checkReveal(pkg, anchored).outcome, "match");
    assert.equal(checkReveal({ ...pkg, report: { ...pkg.report, impact: "worse" } }, anchored).outcome, "mismatch");
    assert.equal(checkReveal({ ...pkg, nonce: newNonce() }, anchored).outcome, "mismatch");
    const { nonce: _n, ...noNonce } = pkg;
    assert.equal(checkReveal(noNonce, anchored).outcome, "missing");
    assert.equal(checkReveal({ ...pkg, nonce: "0x1234" }, anchored).outcome, "invalid-encoding");
    assert.equal(checkReveal({ ...pkg, report: { ...pkg.report, extra: "x" } }, anchored).outcome, "invalid-encoding");
    assert.equal(checkReveal({ ...pkg, commitmentId: 2 }, anchored).outcome, "invalid-encoding");
    assert.equal(checkReveal("not an object", anchored).outcome, "invalid-encoding");
  });
  it("binds the secret nonce into the on-chain reveal digest (no guessing oracle)", async () => {
    const { revealDigest } = await import("../../server/commitment.ts");
    const d = fieldsDigest(report);
    // a guesser who knows the exact report but not the nonce cannot reproduce the digest
    assert.notEqual(revealDigest(1, d, newNonce()), revealDigest(1, d, newNonce()));
  });
  it("salts on-chain digests of short free text", () => {
    assert.notEqual(noteDigest("approved", newNonce()), noteDigest("approved", newNonce()));
  });
});

describe("vault and sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vulnseal-vault-"));
  it("encrypts with AES-256-GCM bound to the record (AAD)", () => {
    const v = Vault.open(dir);
    const sealed = v.seal("report", "report:1", Buffer.from("secret text"));
    assert.ok(!sealed.toString("latin1").includes("secret text"));
    assert.equal(v.open("report", "report:1", sealed).toString(), "secret text");
    assert.throws(() => v.open("report", "report:2", sealed), "a ciphertext moved to another record fails");
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => v.open("report", "report:1", tampered), "tampered ciphertext fails");
    assert.equal((fs.statSync(path.join(dir, "master.key")).mode & 0o777).toString(8), "600");
  });
  it("issues HMAC-signed demo sessions that cannot be forged", () => {
    const s = Sessions.open(dir);
    const token = s.issue("basalt");
    assert.equal(s.verify(token), "basalt");
    assert.equal(s.verify(token.replace("basalt", "auditor")), undefined);
    assert.equal(s.verify(`auditor.${Date.now()}.${randomBytes(32).toString("base64url")}`), undefined);
  });
});

describe("ledger persistence by journal replay", () => {
  it("rebuilds an identical chain after a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vulnseal-journal-"));
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    let chain = await startChain(undefined, { initialDate: "2020-01-01T00:00:00Z" });
    await syncClock(makeProvider(chain.url), journal);
    const keyring = Keyring.generate();
    const { ledger } = await initConsortium({ rpcUrl: chain.url, keyring, store: new Store(path.join(dir, "db.sqlite")), journal, appealWindowSeconds: 60 });
    const hashes: string[] = [];
    const n = await ledger.provider.getBlockNumber();
    for (let i = 0; i <= n; i++) hashes.push((await ledger.provider.getBlock(i))!.hash!);
    const head = await ledger.read("logHead");
    ledger.provider.destroy();
    await chain.stop();

    chain = await startChain(undefined, { initialDate: "2020-01-01T00:00:00Z" });
    const p = makeProvider(chain.url);
    const r = await replay(p, journal);
    assert.equal(r.transactions + r.emptyBlocks, journal.entries().length);
    for (let i = 0; i <= n; i++) assert.equal((await p.getBlock(i))!.hash, hashes[i], `block ${i} identical after replay`);
    const { Contract } = await import("ethers");
    const { loadArtifact } = await import("../../server/chain.ts");
    assert.equal(await new Contract(ledger.address, loadArtifact().abi, p).logHead(), head);
    p.destroy();
    await chain.stop();
  });
});
