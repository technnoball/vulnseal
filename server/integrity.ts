// Auditor's integrity check: recompute the on-chain log, then compare every off-chain
// record (reports, reveals, evidence, rationales, the log mirror) with what the chain
// committed to. Produces a machine-readable report that can be re-verified offline.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AbiCoder, keccak256, ZeroHash } from "ethers";
import { REPORT_SCHEMA, REVEAL_FORMAT, checkReveal, logEntryHash, noteDigest } from "./commitment.ts";
import { LOG_KINDS, STATUS, reportRef } from "./domain.ts";
import type { VulnSealService } from "./service.ts";

export const AUDIT_FORMAT = "vulnseal.audit.v1";
const coder = AbiCoder.defaultAbiCoder();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface Finding {
  severity: "error" | "warning";
  code: string;
  subject: string;
  message: string;
}

export async function auditReport(svc: VulnSealService) {
  const { store, vault, ledger, evidenceDir } = svc.ctx;
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], code: string, subject: string, message: string) => findings.push({ severity, code, subject, message });

  // 1. on-chain log: links, recomputed hashes, head and count
  const log = await svc.chainLog();
  const [head, count] = await Promise.all([ledger.read<string>("logHead"), ledger.read<bigint>("logCount")]);
  let prev = ZeroHash;
  for (const e of log) {
    if (e.prevHash !== prev) add("error", "LOG_LINK_BROKEN", `log #${e.seq}`, "entry does not link to its predecessor");
    const h = logEntryHash(ledger.chainId, ledger.address, { ...e, subject: BigInt(e.subject) });
    if (h !== e.entryHash) add("error", "LOG_HASH_MISMATCH", `log #${e.seq}`, "entry hash does not recompute");
    prev = e.entryHash;
  }
  if (prev !== (log.length ? head : ZeroHash)) add("error", "LOG_HEAD_MISMATCH", "log", "recomputed head differs from the contract's logHead");
  if (log.length !== Number(count)) add("error", "LOG_COUNT_MISMATCH", "log", `chain reports ${count} entries, events show ${log.length}`);

  // 2. off-chain mirror of the log
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const mirror = store.all("SELECT * FROM chain_events ORDER BY seq");
  const mirrored = new Set<number>();
  for (const m of mirror) {
    mirrored.add(m.seq);
    const e = bySeq.get(m.seq);
    if (!e) add("error", "MIRROR_EVENT_UNANCHORED", `log #${m.seq}`, "off-chain event has no on-chain counterpart");
    else if (e.entryHash !== m.entry_hash || e.dataHash !== m.data_hash || e.kind !== m.kind || e.subject !== m.subject)
      add("error", "MIRROR_EVENT_ALTERED", `log #${m.seq}`, `off-chain copy of a "${LOG_KINDS[e.kind]}" event differs from the chain`);
  }
  for (const e of log) if (!mirrored.has(e.seq)) add("error", "MIRROR_EVENT_MISSING", `log #${e.seq}`, `"${LOG_KINDS[e.kind]}" event is missing from the off-chain history (deleted or never stored)`);
  const eventFor = (txHash: string, kind: number) => log.find((e) => e.txHash === txHash && e.kind === kind);

  // 3. commitments vs report rows (and the researcher's sealed original)
  const snap = await svc.snapshot();
  const rows = new Map(store.all("SELECT * FROM reports").map((r) => [r.cid as number, r]));
  for (const c of snap.commitments) {
    const r = rows.get(c.cid);
    const ref = reportRef(c.cid);
    if (!r) {
      add("error", "OFFCHAIN_REPORT_MISSING", ref, "commitment exists on-chain but its off-chain record is missing");
      continue;
    }
    if (r.commitment !== c.commitment) add("error", "REPORT_COMMITMENT_MISMATCH", ref, "stored commitment differs from the anchored one");
    if (String(r.researcher_address).toLowerCase() !== c.researcher.toLowerCase()) add("error", "REPORT_RESEARCHER_MISMATCH", ref, "stored researcher differs from the anchoring address");
    if (r.program_id !== c.programId || r.policy_version !== c.policyVersion) add("error", "REPORT_PROGRAM_MISMATCH", ref, "stored program or policy version differs from the chain");
    if (r.status !== c.status) add("warning", "STATUS_MIRROR_STALE", ref, `off-chain status "${STATUS[r.status]}" differs from on-chain "${STATUS[c.status]}"`);
    try {
      const s = vault.openJson<any>("report", `report:${c.cid}`, r.sealed);
      const pkg = { format: REVEAL_FORMAT, report: { schema: REPORT_SCHEMA, ...s.fields }, nonce: s.nonce };
      const chk = checkReveal(pkg, { cid: c.cid, commitment: c.commitment, chainId: ledger.chainId, contract: ledger.address, researcher: c.researcher, programId: c.programId, policyVersion: c.policyVersion });
      if (chk.outcome !== "match") add("error", "SEALED_ORIGINAL_DIVERGES", ref, `the researcher's sealed original no longer opens the commitment (${chk.outcome})`);
    } catch {
      add("error", "SEALED_REPORT_UNREADABLE", ref, "sealed report fails authenticated decryption (altered ciphertext)");
    }
    rows.delete(c.cid);
  }
  for (const r of rows.values()) add("error", "UNANCHORED_REPORT", reportRef(r.cid), "off-chain report has no on-chain commitment");

  // 4. reveals: stored packages must still produce the outcome recorded on-chain
  const commitments = new Map(snap.commitments.map((c) => [c.cid, c]));
  for (const rv of store.all("SELECT * FROM reveals WHERE outcome IS NOT NULL")) {
    const c = commitments.get(rv.cid);
    const subj = `reveal #${rv.id} (${reportRef(rv.cid)})`;
    if (!c) continue;
    let pkg: unknown;
    try {
      pkg = vault.openJson("reveal", `reveal:${rv.id}`, rv.sealed);
    } catch {
      add("error", "REVEAL_UNREADABLE", subj, "stored reveal fails authenticated decryption");
      continue;
    }
    const chk = checkReveal(pkg, { cid: c.cid, commitment: c.commitment, chainId: ledger.chainId, contract: ledger.address, researcher: c.researcher, programId: c.programId, policyVersion: c.policyVersion });
    if (chk.outcome !== rv.outcome) add("error", "REVEAL_RECHECK_DIFFERS", subj, `stored reveal now checks as "${chk.outcome}" but "${rv.outcome}" was recorded`);
    else if (rv.outcome === "match" && chk.outcome === "match" && chk.revealDigest !== c.revealDigest)
      add("error", "REVEAL_DIGEST_MISMATCH", subj, "reveal digest differs from the one recorded on-chain");
  }

  // 5. evidence files: decrypt, re-hash, and check they are part of the committed report
  for (const e of store.all("SELECT * FROM evidence WHERE cid IS NOT NULL")) {
    const subj = `${e.id} (${reportRef(e.cid)})`;
    const p = path.join(evidenceDir, e.stored_name);
    if (!fs.existsSync(p)) {
      add("error", "EVIDENCE_MISSING", subj, "evidence file is missing");
      continue;
    }
    try {
      const plain = vault.open("evidence", `evidence:${e.id}`, fs.readFileSync(p));
      if (sha256(plain) !== e.sha256) add("error", "EVIDENCE_ALTERED", subj, "file no longer matches its recorded SHA-256");
      const r = store.get("SELECT sealed FROM reports WHERE cid = ?", e.cid);
      if (r) {
        const s = vault.openJson<any>("report", `report:${e.cid}`, r.sealed);
        if (!s.fields.evidence.includes(e.sha256)) add("error", "EVIDENCE_NOT_COMMITTED", subj, "recorded SHA-256 is not in the committed evidence set");
      }
    } catch {
      add("error", "EVIDENCE_UNREADABLE", subj, "evidence fails authenticated decryption");
    }
  }

  // 6. rationales: sealed text -> salted digest -> on-chain data hash
  for (const a of store.all("SELECT * FROM associations")) {
    const subj = `association #${a.aid}`;
    const text = vault.open("rationale", `assoc:${a.aid}`, a.sealed).toString("utf8");
    if (noteDigest(text, a.salt) !== a.digest) add("error", "RATIONALE_ALTERED", subj, "stored rationale no longer matches its digest");
    const ev = eventFor(a.tx_hash, 11);
    const want = keccak256(coder.encode(["uint64", "uint64", "uint8", "bytes32"], [a.cid_a, a.cid_b, a.relation, a.digest]));
    if (!ev || ev.dataHash !== want) add("error", "RATIONALE_NOT_ANCHORED", subj, "proposal digest differs from the on-chain record");
  }
  for (const d of store.all("SELECT * FROM disputes")) {
    const subj = `dispute #${d.did}`;
    const text = vault.open("rationale", `dispute:${d.did}`, d.sealed).toString("utf8");
    if (noteDigest(text, d.salt) !== d.digest) add("error", "RATIONALE_ALTERED", subj, "stored statement no longer matches its digest");
    const ev = eventFor(d.tx_hash, 13);
    const want = keccak256(coder.encode(["uint8", "uint64", "bytes32"], [d.kind, d.subject, d.digest]));
    if (!ev || ev.dataHash !== want) add("error", "RATIONALE_NOT_ANCHORED", subj, "statement digest differs from the on-chain record");
  }
  for (const v of store.all("SELECT * FROM dispute_acts WHERE act = 'vote'")) {
    const subj = `vote in dispute #${v.did}`;
    const text = vault.open("rationale", `act:${v.id}`, v.sealed).toString("utf8");
    if (noteDigest(text, v.salt) !== v.digest) add("error", "RATIONALE_ALTERED", subj, "stored vote rationale no longer matches its digest");
    const ev = eventFor(v.tx_hash, 14);
    const want = keccak256(coder.encode(["uint8", "uint8", "uint16", "bytes32"], [v.round, v.decision, v.reason_code, v.digest]));
    if (!ev || ev.dataHash !== want) add("error", "RATIONALE_NOT_ANCHORED", subj, "vote record differs from the on-chain record");
  }

  return {
    format: AUDIT_FORMAT,
    generatedAt: new Date().toISOString(),
    notice: "Synthetic research prototype data. A clean report shows the off-chain records match what was committed on-chain; it does not show that any report or decision is correct.",
    ok: !findings.some((f) => f.severity === "error"),
    chain: { chainId: ledger.chainId, contract: ledger.address, logHead: head, logCount: Number(count), blockNumber: await ledger.provider.getBlockNumber() },
    counts: {
      logEntries: log.length,
      commitments: snap.commitments.length,
      reveals: store.get("SELECT COUNT(*) n FROM reveals")!.n,
      evidence: store.get("SELECT COUNT(*) n FROM evidence WHERE cid IS NOT NULL")!.n,
      associations: snap.associations.length,
      disputes: snap.disputes.length,
    },
    findings,
    log,
    commitments: snap.commitments,
    associations: snap.associations,
    disputes: snap.disputes,
  };
}

/** Offline re-verification of an exported audit report; optionally against a live chain. */
export function verifyAuditExport(x: any): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (x?.format !== AUDIT_FORMAT) problems.push("not a vulnseal.audit.v1 export");
  let prev = ZeroHash;
  for (const e of x?.log ?? []) {
    if (e.prevHash !== prev) problems.push(`log #${e.seq}: broken link`);
    const h = logEntryHash(x.chain.chainId, x.chain.contract, { ...e, subject: BigInt(e.subject) });
    if (h !== e.entryHash) problems.push(`log #${e.seq}: hash does not recompute`);
    prev = e.entryHash;
  }
  if ((x?.log?.length ?? 0) > 0 && prev !== x.chain.logHead) problems.push("recomputed head differs from the exported logHead");
  return { ok: problems.length === 0, problems };
}
