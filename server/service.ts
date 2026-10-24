// VulnSeal domain service. Every state change is a contract transaction signed by the
// acting demo identity; the contract decides whether it is allowed. Confidential
// material (report text, nonces, evidence, rationales, notes) only exists off-chain,
// sealed with the vault, and every read of it passes contentAccess().
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ZeroHash, getAddress, hexlify, type LogDescription } from "ethers";
import { LedgerError, type Ledger, type TxResult } from "./chain.ts";
import {
  REPORT_FIELDS,
  REPORT_SCHEMA,
  REVEAL_FORMAT,
  checkReveal,
  computeCommitment,
  fieldsDigest,
  newNonce,
  noteDigest,
  revealDigest,
  type ReportFields,
  type RevealCheck,
  type RevealPackage,
} from "./commitment.ts";
import type { Store, Row } from "./db.ts";
import {
  ASSOC_STATUS,
  DECISION_NAMES,
  DISPUTE_KIND_NAMES,
  DISPUTE_STATUS,
  IDENTITY_DEFS,
  LOG_KINDS,
  PROGRAMS,
  REASON_CODES,
  RELATION_NAMES,
  REVEAL,
  REVEAL_NAMES,
  ROLE,
  SEVERITIES,
  ST,
  STATUS,
  TRIAGE_TARGETS,
  identityDef,
  programDef,
  reportRef,
  type IdentityDef,
} from "./domain.ts";
import type { Keyring } from "./keys.ts";
import { buildReceipt, verifyReceipt, type Receipt } from "./receipt.ts";
import type { Vault } from "./vault.ts";

export class ServiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ServiceCtx {
  store: Store;
  vault: Vault;
  ledger: Ledger;
  keyring: Keyring;
  evidenceDir: string;
}

export type Viewer = IdentityDef & { address: string };

export const LIMITS = { title: 140, description: 4000, impact: 1500, reproduction: 4000, scope: 300, privateNotes: 2000, note: 2000, rationale: 3000 };
export const EVIDENCE_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "text/plain", "application/json", "text/csv"]);
export const MAX_EVIDENCE = 5 * 1024 * 1024;

export interface ChainCommitment {
  cid: number;
  commitment: string;
  researcher: string;
  programId: number;
  policyVersion: number;
  status: number;
  mismatches: number;
  anchoredAt: number;
  supersedes: number;
  supersededBy: number;
  logSeq: number;
  revealDigest: string;
  family: string;
}
export interface ChainAssociation {
  aid: number;
  cidA: number;
  cidB: number;
  relation: number;
  status: number;
  reviewedStatus: number;
  decidedRelation: number;
  proposerProgram: number;
  proposer: string;
  reviewer: string;
}
export interface ChainDispute {
  did: number;
  kind: number;
  status: number;
  round: number;
  decision: number;
  reasonCode: number;
  firstDecision: number;
  firstReason: number;
  reversed: boolean;
  subject: number;
  cidA: number;
  cidB: number;
  progA: number;
  progB: number;
  opener: string;
  openedAt: number;
  decidedAt: number;
  priorityTo: number;
  policyDigest: string;
}

interface SealedReport {
  schema: string;
  fields: ReportFields;
  nonce: string;
  evidenceIds: string[];
  privateNotes: string;
  createdAt: string;
}

const iso = (t: number) => (t ? new Date(t * 1000).toISOString() : null);
const now = () => new Date().toISOString();
const salt = () => hexlify(randomBytes(32));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function text(v: unknown, name: string, max: number, required = true): string {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new ServiceError(`${name} is required`, 422);
    return "";
  }
  if (typeof v !== "string") throw new ServiceError(`${name} must be text`, 422);
  const t = v.trim();
  if (t.length > max) throw new ServiceError(`${name} must be at most ${max} characters`, 422);
  return t;
}
function int(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ServiceError(`${name} must be a whole number`, 422);
  return n;
}

export class VulnSealService {
  readonly ctx: ServiceCtx;
  constructor(ctx: ServiceCtx) {
    this.ctx = ctx;
  }
  get store() {
    return this.ctx.store;
  }
  get ledger() {
    return this.ctx.ledger;
  }

  // ================================================================ identities
  viewer(id: string | undefined): Viewer | undefined {
    const d = identityDef(id);
    return d ? { ...d, address: this.ctx.keyring.address(d.id) } : undefined;
  }
  requireViewer(id: string | undefined): Viewer {
    const v = this.viewer(id);
    if (!v) throw new ServiceError("Choose a demo identity first (top right). This is a simulated sign-in, not real authentication.", 401);
    return v;
  }
  identities() {
    return IDENTITY_DEFS.map((d) => ({
      ...d,
      address: this.ctx.keyring.address(d.id),
      programName: d.programId ? programDef(d.programId)?.name : null,
    }));
  }
  labelOf(address: string) {
    const id = this.ctx.keyring.idOf(address);
    const d = identityDef(id);
    return d ? { id: d.id, label: d.label, kind: d.kind, address } : { id: null, label: `${address.slice(0, 8)}…`, kind: "unknown", address };
  }
  privateIdentity(viewer: Viewer) {
    const row = this.store.get("SELECT sealed FROM identity_private WHERE identity_id = ?", viewer.id);
    if (!row) return null;
    this.logAccess(viewer, "read-private-identity", viewer.id, true);
    return this.ctx.vault.openJson("identity", `identity:${viewer.id}`, row.sealed);
  }
  setPrivateIdentity(id: string, data: unknown) {
    const sealed = this.ctx.vault.sealJson("identity", `identity:${id}`, data);
    this.store.run("INSERT INTO identity_private(identity_id, sealed) VALUES (?, ?) ON CONFLICT(identity_id) DO UPDATE SET sealed = excluded.sealed", id, sealed);
  }

  // ================================================================ chain plumbing
  async tx(actor: string, method: string, args: unknown[]): Promise<TxResult> {
    const r = await this.ledger.send(actor, method, args);
    this.mirrorEvents(r.events, r.hash, r.blockNumber);
    return r;
  }

  private mirrorEvents(events: LogDescription[], txHash: string, blockNumber: number) {
    for (const e of events) {
      if (e.name !== "LogAppended") continue;
      this.store.run(
        `INSERT OR IGNORE INTO chain_events(seq, kind, subject, actor, data_hash, entry_hash, timestamp, tx_hash, block_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        Number(e.args.seq),
        Number(e.args.kind),
        String(e.args.subject),
        e.args.actor,
        e.args.dataHash,
        e.args.entryHash,
        Number(e.args.timestamp),
        txHash,
        blockNumber,
      );
    }
  }

  /** Read every LogAppended event from the chain (used at startup and by the auditor). */
  async chainLog() {
    const c = this.ledger.contract;
    const logs = await c.queryFilter(c.filters.LogAppended(), 0, "latest");
    return logs.map((l: any) => ({
      seq: Number(l.args.seq),
      kind: Number(l.args.kind),
      subject: String(l.args.subject),
      actor: l.args.actor as string,
      timestamp: Number(l.args.timestamp),
      dataHash: l.args.dataHash as string,
      prevHash: l.args.prevHash as string,
      entryHash: l.args.entryHash as string,
      txHash: l.transactionHash as string,
      blockNumber: l.blockNumber as number,
    }));
  }

  /** Fill the off-chain log mirror from the chain (inserts only; never overwrites). */
  async syncLogMirror(): Promise<number> {
    let n = 0;
    for (const e of await this.chainLog()) {
      const r = this.store.run(
        `INSERT OR IGNORE INTO chain_events(seq, kind, subject, actor, data_hash, entry_hash, timestamp, tx_hash, block_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.seq, e.kind, e.subject, e.actor, e.dataHash, e.entryHash, e.timestamp, e.txHash, e.blockNumber,
      );
      n += Number(r.changes);
    }
    return n;
  }

  async commitmentOnChain(cid: number): Promise<ChainCommitment> {
    const c = await this.ledger.read("getCommitment", cid);
    return {
      cid,
      commitment: c.commitment,
      researcher: c.researcher,
      programId: Number(c.programId),
      policyVersion: Number(c.policyVersion),
      status: Number(c.status),
      mismatches: Number(c.mismatches),
      anchoredAt: Number(c.anchoredAt),
      supersedes: Number(c.supersedes),
      supersededBy: Number(c.supersededBy),
      logSeq: Number(c.logSeq),
      revealDigest: c.revealDigest,
      family: c.family,
    };
  }

  async associationOnChain(aid: number): Promise<ChainAssociation> {
    const s = await this.ledger.read("getAssociation", aid);
    return {
      aid,
      cidA: Number(s.cidA),
      cidB: Number(s.cidB),
      relation: Number(s.relation),
      status: Number(s.status),
      reviewedStatus: Number(s.reviewedStatus),
      decidedRelation: Number(s.decidedRelation),
      proposerProgram: Number(s.proposerProgram),
      proposer: s.proposer,
      reviewer: s.reviewer,
    };
  }

  async disputeOnChain(did: number): Promise<ChainDispute> {
    const d = await this.ledger.read("getDispute", did);
    return {
      did,
      kind: Number(d.kind),
      status: Number(d.status),
      round: Number(d.round),
      decision: Number(d.decision),
      reasonCode: Number(d.reasonCode),
      firstDecision: Number(d.firstDecision),
      firstReason: Number(d.firstReason),
      reversed: Boolean(d.reversed),
      subject: Number(d.subject),
      cidA: Number(d.cidA),
      cidB: Number(d.cidB),
      progA: Number(d.progA),
      progB: Number(d.progB),
      opener: d.opener,
      openedAt: Number(d.openedAt),
      decidedAt: Number(d.decidedAt),
      priorityTo: Number(d.priorityTo),
      policyDigest: d.policyDigest,
    };
  }

  async snapshot() {
    const [nc, na, nd] = await Promise.all([this.ledger.read("commitmentCount"), this.ledger.read("associationCount"), this.ledger.read("disputeCount")]);
    const range = (n: bigint) => Array.from({ length: Number(n) }, (_, i) => i + 1);
    const [commitments, associations, disputes] = await Promise.all([
      Promise.all(range(nc).map((i) => this.commitmentOnChain(i))),
      Promise.all(range(na).map((i) => this.associationOnChain(i))),
      Promise.all(range(nd).map((i) => this.disputeOnChain(i))),
    ]);
    return { commitments, associations, disputes };
  }

  private report(cid: number): Row {
    const r = this.store.get("SELECT * FROM reports WHERE cid = ?", cid);
    if (!r) throw new ServiceError(`No report ${reportRef(cid)} in the off-chain store`, 404);
    return r;
  }
  private openReport(r: Row): SealedReport {
    return this.ctx.vault.openJson<SealedReport>("report", `report:${r.cid}`, r.sealed);
  }
  private async refreshReport(cid: number) {
    const c = await this.commitmentOnChain(cid);
    this.store.run(
      "UPDATE reports SET status = ?, mismatches = ?, reveal_digest = ?, superseded_by = ? WHERE cid = ?",
      c.status,
      c.mismatches,
      c.revealDigest === ZeroHash ? null : c.revealDigest,
      c.supersededBy || null,
      cid,
    );
    return c;
  }

  // ================================================================ access policy
  logAccess(viewer: Viewer | undefined, action: string, object: string, allowed: boolean) {
    this.store.run("INSERT INTO access_log(at, identity_id, action, object, allowed) VALUES (?, ?, ?, ?, ?)", now(), viewer?.id ?? "anonymous", action, object, allowed ? 1 : 0);
  }

  /** Who may read a report's confidential content, and which version (vault original or revealed copy). */
  async contentAccess(viewer: Viewer | undefined, cid: number): Promise<{ allowed: boolean; scope: "owner" | "program" | "disclosed" | "arbitrator" | "none"; reason: string }> {
    const r = this.report(cid);
    if (!viewer) return { allowed: false, scope: "none", reason: "No identity selected." };
    if (viewer.id === r.researcher_id) return { allowed: true, scope: "owner", reason: "You committed this report." };
    const revealed = this.store.get("SELECT id FROM reveals WHERE cid = ? LIMIT 1", cid);
    const staff = viewer.kind === "program-admin" || viewer.kind === "reviewer";
    if (staff && viewer.programId === r.program_id) {
      return revealed
        ? { allowed: true, scope: "program", reason: "Your program received this report and the researcher has revealed it." }
        : { allowed: false, scope: "none", reason: "The researcher has not revealed this report to your program yet; only its commitment is visible." };
    }
    if (staff && revealed && (await this.ledger.read<boolean>("disclosedTo", cid, viewer.programId))) {
      return { allowed: true, scope: "disclosed", reason: "Disclosure to your program was granted on-chain." };
    }
    if (viewer.kind === "arbitrator" && revealed) {
      const { disputes } = await this.disputesFor(cid);
      const conflicted = (d: ChainDispute) => viewer.programId !== 0 && (viewer.programId === d.progA || viewer.programId === d.progB);
      if (disputes.some((d) => d.status !== 4 && !conflicted(d))) {
        return { allowed: true, scope: "arbitrator", reason: "You are eligible to arbitrate an active dispute that involves this report." };
      }
      return { allowed: false, scope: "none", reason: "Arbitrators only see report content while an active dispute involving it is before them (and never when conflicted)." };
    }
    if (viewer.kind === "auditor") return { allowed: false, scope: "none", reason: "Auditors see commitments, digests and decisions, not report content." };
    return { allowed: false, scope: "none", reason: "You are not authorized to read this report's confidential content." };
  }

  private async disputesFor(cid: number) {
    const rows = this.store.all("SELECT did FROM disputes WHERE cid_a = ? OR cid_b = ?", cid, cid);
    return { disputes: await Promise.all(rows.map((r) => this.disputeOnChain(r.did))) };
  }

  // ================================================================ evidence
  uploadEvidence(viewer: Viewer, file: { buffer: Uint8Array; originalname: string; mimetype: string } | undefined) {
    if (viewer.kind !== "researcher") throw new ServiceError("Only researchers attach evidence to their own reports.", 403);
    if (!file) throw new ServiceError("No file was uploaded", 422);
    if (!EVIDENCE_MIME.has(file.mimetype)) throw new ServiceError(`File type ${file.mimetype} is not accepted (PDF, PNG, JPEG, text, CSV or JSON)`, 415);
    if (!file.buffer.byteLength) throw new ServiceError("The file is empty", 422);
    if (file.buffer.byteLength > MAX_EVIDENCE) throw new ServiceError("Evidence files are limited to 5 MB", 413);
    const id = `EV-${randomBytes(6).toString("hex").toUpperCase()}`;
    const stored = `${randomBytes(16).toString("hex")}.sealed`;
    fs.mkdirSync(this.ctx.evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(this.ctx.evidenceDir, stored), this.ctx.vault.seal("evidence", `evidence:${id}`, file.buffer), { flag: "wx" });
    const name = (file.originalname || "evidence").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const digest = sha256(file.buffer);
    this.store.run(
      "INSERT INTO evidence(id, owner_id, cid, sha256, size, mime, sealed_name, stored_name, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)",
      id,
      viewer.id,
      digest,
      file.buffer.byteLength,
      file.mimetype,
      this.ctx.vault.seal("evidence", `evidence-name:${id}`, Buffer.from(name)),
      stored,
      now(),
    );
    return { id, sha256: digest, size: file.buffer.byteLength, mime: file.mimetype, filename: name };
  }

  pendingEvidence(viewer: Viewer) {
    return this.store.all("SELECT * FROM evidence WHERE owner_id = ? AND cid IS NULL ORDER BY created_at", viewer.id).map((e) => this.evidenceMeta(e, true));
  }

  private evidenceMeta(e: Row, withName: boolean) {
    return {
      id: e.id,
      sha256: e.sha256,
      size: e.size,
      mime: e.mime,
      cid: e.cid,
      filename: withName ? this.ctx.vault.open("evidence", `evidence-name:${e.id}`, e.sealed_name).toString("utf8") : null,
    };
  }

  async evidenceFile(viewer: Viewer, id: string) {
    const e = this.store.get("SELECT * FROM evidence WHERE id = ?", id);
    if (!e) throw new ServiceError("Evidence not found", 404);
    const allowed = e.cid === null ? e.owner_id === viewer.id : (await this.contentAccess(viewer, e.cid)).allowed;
    this.logAccess(viewer, "read-evidence", id, allowed);
    if (!allowed) throw new ServiceError("You are not authorized to open this evidence file.", 403);
    const plain = this.ctx.vault.open("evidence", `evidence:${id}`, fs.readFileSync(path.join(this.ctx.evidenceDir, e.stored_name)));
    return { data: plain, mime: e.mime, filename: this.evidenceMeta(e, true).filename, sha256Matches: sha256(plain) === e.sha256 };
  }

  // ================================================================ researcher
  private reportFields(input: Record<string, unknown>, evidence: string[]): ReportFields {
    const severity = String(input.severity ?? "");
    if (!(SEVERITIES as readonly string[]).includes(severity)) throw new ServiceError(`Severity must be one of ${SEVERITIES.join(", ")}`, 422);
    return {
      title: text(input.title, "Title", LIMITS.title),
      description: text(input.description, "Description", LIMITS.description),
      impact: text(input.impact, "Impact", LIMITS.impact),
      reproduction: text(input.reproduction, "Reproduction notes", LIMITS.reproduction),
      scope: text(input.scope, "Scope", LIMITS.scope),
      severity,
      evidence,
    };
  }

  /** Create a report, commit to it on-chain and seal it in the researcher's vault. */
  async commitReport(viewer: Viewer, input: Record<string, unknown>, supersedes?: number) {
    const programId = int(input.programId, "Program");
    if (!programDef(programId)) throw new ServiceError("Unknown program", 422);
    const evidenceIds = Array.isArray(input.evidenceIds) ? [...new Set(input.evidenceIds.map(String))] : [];
    if (evidenceIds.length > 10) throw new ServiceError("At most 10 evidence files per report", 422);
    const ev = evidenceIds.map((id) => {
      const e = this.store.get("SELECT * FROM evidence WHERE id = ?", id);
      if (!e || e.owner_id !== viewer.id) throw new ServiceError(`Evidence ${id} is not one of your uploads`, 403);
      if (e.cid !== null) throw new ServiceError(`Evidence ${id} is already committed in ${reportRef(e.cid)}`, 409);
      return e;
    });
    const fields = this.reportFields(input, ev.map((e) => e.sha256));
    const privateNotes = text(input.privateNotes, "Private notes", LIMITS.privateNotes, false);
    const program = await this.ledger.read("programs", programId);
    const policyVersion = Number(program.policyVersion);
    const nonce = newNonce();
    const digest = fieldsDigest(fields);
    const commitment = computeCommitment(
      { chainId: this.ledger.chainId, contract: this.ledger.address, researcher: viewer.address, programId, policyVersion },
      digest,
      nonce,
    );
    const tx = supersedes
      ? await this.tx(viewer.id, "reviseCommitment", [supersedes, commitment, policyVersion])
      : await this.tx(viewer.id, "anchorCommitment", [commitment, programId, policyVersion]);
    const anchored = tx.events.find((e) => e.name === "CommitmentAnchored")!;
    const cid = Number(anchored.args.cid);
    const onchain = await this.commitmentOnChain(cid);
    const sealed: SealedReport = { schema: REPORT_SCHEMA, fields, nonce, evidenceIds, privateNotes, createdAt: now() };
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO reports(cid, researcher_id, researcher_address, program_id, policy_version, commitment, supersedes, superseded_by,
           status, mismatches, reveal_digest, anchored_at, log_seq, tx_hash, block_number, gas_used, sealed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        cid,
        viewer.id,
        viewer.address,
        programId,
        policyVersion,
        commitment,
        supersedes ?? null,
        onchain.status,
        onchain.anchoredAt,
        onchain.logSeq,
        tx.hash,
        tx.blockNumber,
        tx.gasUsed,
        this.ctx.vault.sealJson("report", `report:${cid}`, sealed),
        now(),
      );
      for (const e of ev) this.store.run("UPDATE evidence SET cid = ? WHERE id = ?", cid, e.id);
      if (supersedes) this.store.run("UPDATE reports SET superseded_by = ? WHERE cid = ?", cid, supersedes);
    });
    return { cid, ref: reportRef(cid), commitment, policyVersion, tx: { hash: tx.hash, blockNumber: tx.blockNumber, gasUsed: tx.gasUsed }, receipt: await this.receipt(viewer, cid) };
  }

  async reviseReport(viewer: Viewer, cid: number, input: Record<string, unknown>) {
    const r = this.report(cid);
    if (r.researcher_id !== viewer.id) throw new ServiceError("Only the researcher who committed this report can revise it.", 403);
    return this.commitReport(viewer, { ...input, programId: r.program_id }, cid);
  }

  async receipt(viewer: Viewer, cid: number): Promise<Receipt> {
    const r = this.report(cid);
    const staff = (viewer.kind === "program-admin" || viewer.kind === "reviewer") && viewer.programId === r.program_id;
    if (viewer.id !== r.researcher_id && !staff && viewer.kind !== "auditor") {
      throw new ServiceError("Receipts are issued to the researcher, the receiving program and auditors.", 403);
    }
    const c = await this.commitmentOnChain(cid);
    const block = await this.ledger.provider.getBlock(r.block_number);
    const program = await this.ledger.read("programs", c.programId);
    return buildReceipt({
      reportRef: reportRef(cid),
      commitmentId: cid,
      commitment: c.commitment,
      researcher: getAddress(c.researcher),
      programId: c.programId,
      programNameTag: program.nameTag,
      policyVersion: c.policyVersion,
      policyDigest: await this.ledger.read("policyDigest", c.programId, c.policyVersion),
      chainId: this.ledger.chainId,
      contract: this.ledger.address,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      blockHash: block?.hash ?? "",
      anchoredAt: c.anchoredAt,
      logSeq: c.logSeq,
      logEntryHash: await this.ledger.read("logEntries", c.logSeq),
      supersedes: c.supersedes,
    });
  }

  /** The researcher's private reveal material. Whoever holds it can reveal the report. */
  async recoveryPackage(viewer: Viewer, cid: number): Promise<RevealPackage & { receipt: Receipt; warning: string }> {
    const r = this.report(cid);
    if (r.researcher_id !== viewer.id) {
      this.logAccess(viewer, "read-recovery-package", reportRef(cid), false);
      throw new ServiceError("Only the researcher who committed this report can download its recovery package.", 403);
    }
    this.logAccess(viewer, "read-recovery-package", reportRef(cid), true);
    const s = this.openReport(r);
    return {
      format: REVEAL_FORMAT,
      warning: "PRIVATE. Contains the secret nonce and the full report. Anyone holding this file can reveal the report. If the nonce is lost the commitment can never be opened.",
      commitmentId: cid,
      chainId: this.ledger.chainId,
      contract: this.ledger.address,
      researcher: r.researcher_address,
      programId: r.program_id,
      policyVersion: r.policy_version,
      report: { schema: REPORT_SCHEMA, ...s.fields },
      nonce: s.nonce,
      receipt: await this.receipt(viewer, cid),
    };
  }

  private anchoredCtx(r: Row, c: ChainCommitment) {
    return { cid: c.cid, commitment: c.commitment, chainId: this.ledger.chainId, contract: this.ledger.address, researcher: c.researcher, programId: c.programId, policyVersion: c.policyVersion };
  }

  /** Check a reveal locally and with the contract's verifyOpening (an eth_call, not a transaction). */
  async checkPackage(r: Row, pkg: unknown): Promise<RevealCheck & { contractAgrees: boolean | null }> {
    const c = await this.commitmentOnChain(r.cid);
    const check = checkReveal(pkg, this.anchoredCtx(r, c));
    let contractAgrees: boolean | null = null;
    if (check.outcome === "match" || check.outcome === "mismatch") {
      const ok = await this.ledger.read<boolean>("verifyOpening", r.cid, check.fieldsDigest, (pkg as RevealPackage).nonce);
      contractAgrees = ok === (check.outcome === "match");
    }
    return { ...check, contractAgrees };
  }

  /**
   * Researcher reveals to the receiving program. mode "vault" uses the sealed original;
   * "package" takes an uploaded recovery package; "edited" applies field edits to the
   * original (to demonstrate that altered content is detected).
   */
  async submitReveal(viewer: Viewer, cid: number, body: Record<string, any>) {
    const r = this.report(cid);
    if (r.researcher_id !== viewer.id) throw new ServiceError(`Only the researcher who committed ${reportRef(cid)} can reveal it.`, 403);
    const c = await this.commitmentOnChain(cid);
    if (c.supersededBy) throw new ServiceError(`${reportRef(cid)} was replaced by ${reportRef(c.supersededBy)}; reveal the newer report.`, 409);
    if (c.status !== ST.REVEAL_REQUESTED) {
      throw new ServiceError(
        c.status < ST.REVEAL_REQUESTED
          ? "The program has not requested a reveal yet. Revealing early would disclose the report before the agreed process allows it."
          : "This report has already been revealed and verified.",
        409,
      );
    }
    const mode = String(body.mode ?? "vault");
    let pkg: any;
    const s = this.openReport(r);
    const base = {
      format: REVEAL_FORMAT,
      commitmentId: cid,
      chainId: this.ledger.chainId,
      contract: this.ledger.address,
      researcher: r.researcher_address,
      programId: r.program_id,
      policyVersion: r.policy_version,
      report: { schema: REPORT_SCHEMA, ...s.fields },
      nonce: s.nonce,
    };
    if (mode === "vault") pkg = base;
    else if (mode === "edited") {
      const edits = (body.edits ?? {}) as Record<string, unknown>;
      const report: Record<string, unknown> = { ...base.report };
      for (const f of REPORT_FIELDS) if (typeof edits[f] === "string") report[f] = edits[f];
      pkg = { ...base, report };
    } else if (mode === "package") {
      pkg = body.package;
      if (typeof pkg === "string") {
        try {
          pkg = JSON.parse(pkg);
        } catch {
          pkg = null;
        }
      }
    } else throw new ServiceError("mode must be vault, edited or package", 422);
    const check = await this.checkPackage(r, pkg);
    const res = this.store.run(
      "INSERT INTO reveals(cid, submitted_by, submitted_at, source, precheck, sealed) VALUES (?, ?, ?, ?, ?, ?)",
      cid,
      viewer.id,
      now(),
      mode,
      check.outcome,
      Buffer.alloc(0),
    );
    const id = Number(res.lastInsertRowid);
    this.store.run("UPDATE reveals SET sealed = ? WHERE id = ?", this.ctx.vault.sealJson("reveal", `reveal:${id}`, pkg ?? null), id);
    return { revealId: id, precheck: check, note: "Disclosed to the receiving program's staff, who verify it and record the result on-chain." };
  }

  // ================================================================ program
  private requireStaffOf(viewer: Viewer, programId: number) {
    if ((viewer.kind !== "program-admin" && viewer.kind !== "reviewer") || viewer.programId !== programId) {
      throw new ServiceError("Only staff of the receiving program can do this.", 403);
    }
  }

  async acknowledge(viewer: Viewer, cid: number) {
    this.report(cid);
    const tx = await this.tx(viewer.id, "acknowledge", [cid]);
    await this.refreshReport(cid);
    return { tx: tx.hash };
  }

  async requestReveal(viewer: Viewer, cid: number) {
    this.report(cid);
    const tx = await this.tx(viewer.id, "requestReveal", [cid]);
    await this.refreshReport(cid);
    return { tx: tx.hash };
  }

  /** Program reviewer re-checks a submitted reveal and records the outcome on-chain. */
  async verifyReveal(viewer: Viewer, revealId: number) {
    const rv = this.store.get("SELECT * FROM reveals WHERE id = ?", revealId);
    if (!rv) throw new ServiceError("Reveal not found", 404);
    const r = this.report(rv.cid);
    this.requireStaffOf(viewer, r.program_id);
    const pkg = this.ctx.vault.openJson("reveal", `reveal:${revealId}`, rv.sealed);
    const check = await this.checkPackage(r, pkg);
    const code = { match: REVEAL.MATCH, mismatch: REVEAL.MISMATCH, missing: REVEAL.MISSING, "invalid-encoding": REVEAL.BAD_ENCODING }[check.outcome];
    const digest = check.outcome === "match" || check.outcome === "mismatch" ? check.revealDigest : ZeroHash;
    const tx = await this.tx(viewer.id, "recordReveal", [r.cid, code, digest]);
    this.store.run("UPDATE reveals SET verified_by = ?, verified_at = ?, outcome = ?, reveal_digest = ?, tx_hash = ? WHERE id = ?", viewer.id, now(), check.outcome, digest, tx.hash, revealId);
    await this.refreshReport(r.cid);
    return { outcome: check.outcome, check, tx: tx.hash };
  }

  async triage(viewer: Viewer, cid: number, target: string, note: string) {
    this.report(cid);
    const to = TRIAGE_TARGETS[target as keyof typeof TRIAGE_TARGETS];
    if (!to) throw new ServiceError(`Triage target must be one of ${Object.keys(TRIAGE_TARGETS).join(", ")}`, 422);
    const n = text(note, "Triage note", LIMITS.note, false);
    const s = salt();
    const tx = await this.tx(viewer.id, "setTriage", [cid, to, n ? noteDigest(n, s) : ZeroHash]);
    if (n) this.addNoteRow(viewer, cid, `[triage → ${STATUS[to]}] ${n}`);
    await this.refreshReport(cid);
    return { tx: tx.hash, status: STATUS[to] };
  }

  private addNoteRow(viewer: Viewer, cid: number, body: string) {
    const r = this.report(cid);
    const res = this.store.run("INSERT INTO notes(cid, program_id, author_id, sealed, created_at) VALUES (?, ?, ?, ?, ?)", cid, r.program_id, viewer.id, Buffer.alloc(0), now());
    const id = Number(res.lastInsertRowid);
    this.store.run("UPDATE notes SET sealed = ? WHERE id = ?", this.ctx.vault.seal("note", `note:${id}`, Buffer.from(body)), id);
    return id;
  }

  addNote(viewer: Viewer, cid: number, body: string) {
    const r = this.report(cid);
    this.requireStaffOf(viewer, r.program_id);
    return { id: this.addNoteRow(viewer, cid, text(body, "Note", LIMITS.note)) };
  }

  async grantDisclosure(viewer: Viewer, cid: number, toProgram: number) {
    this.report(cid);
    const tx = await this.tx(viewer.id, "grantDisclosure", [cid, toProgram]);
    this.store.run("INSERT OR IGNORE INTO grants(cid, to_program, granted_by, tx_hash, created_at) VALUES (?, ?, ?, ?, ?)", cid, toProgram, viewer.id, tx.hash, now());
    return { tx: tx.hash };
  }

  async finalizeReport(viewer: Viewer, cid: number, note: string) {
    this.report(cid);
    const n = text(note, "Disposition note", LIMITS.note);
    const tx = await this.tx(viewer.id, "finalizeReport", [cid, noteDigest(n, salt())]);
    this.addNoteRow(viewer, cid, `[final disposition] ${n}`);
    await this.refreshReport(cid);
    return { tx: tx.hash };
  }

  async programInbox(viewer: Viewer) {
    if (viewer.kind !== "program-admin" && viewer.kind !== "reviewer") throw new ServiceError("The program workspace is for program staff.", 403);
    const rows = this.store.all("SELECT * FROM reports WHERE program_id = ? ORDER BY cid DESC", viewer.programId);
    const items = [];
    for (const r of rows) {
      const c = await this.commitmentOnChain(r.cid);
      const reveals = this.store.all("SELECT id, submitted_at, source, precheck, outcome, verified_by, tx_hash FROM reveals WHERE cid = ? ORDER BY id", r.cid);
      const access = await this.contentAccess(viewer, r.cid);
      const title = access.allowed ? this.revealedFields(r)?.title ?? null : null;
      items.push({
        cid: r.cid,
        ref: reportRef(r.cid),
        researcher: this.labelOf(r.researcher_address),
        status: c.status,
        statusName: STATUS[c.status],
        anchoredAt: iso(c.anchoredAt),
        mismatches: c.mismatches,
        supersededBy: c.supersededBy || null,
        supersedes: c.supersedes || null,
        title,
        reveals,
        pendingVerification: reveals.filter((x) => !x.outcome).map((x) => x.id),
      });
    }
    // other programs' reports disclosed to this program
    const disclosed = this.store.all("SELECT g.cid FROM grants g WHERE g.to_program = ?", viewer.programId).map((g) => g.cid);
    return { programId: viewer.programId, program: programDef(viewer.programId), items, disclosed };
  }

  /** Latest revealed fields (prefer the verified match), as seen by a program. */
  private revealedFields(r: Row): (ReportFields & { revealId: number; precheck: string; outcome: string | null }) | null {
    const rv =
      this.store.get("SELECT * FROM reveals WHERE cid = ? AND outcome = 'match' ORDER BY id DESC LIMIT 1", r.cid) ??
      this.store.get("SELECT * FROM reveals WHERE cid = ? ORDER BY id DESC LIMIT 1", r.cid);
    if (!rv) return null;
    const pkg = this.ctx.vault.openJson<any>("reveal", `reveal:${rv.id}`, rv.sealed);
    const rep = pkg?.report ?? {};
    return {
      title: String(rep.title ?? ""),
      description: String(rep.description ?? ""),
      impact: String(rep.impact ?? ""),
      reproduction: String(rep.reproduction ?? ""),
      scope: String(rep.scope ?? ""),
      severity: String(rep.severity ?? ""),
      evidence: Array.isArray(rep.evidence) ? rep.evidence : [],
      revealId: rv.id,
      precheck: rv.precheck,
      outcome: rv.outcome,
    };
  }

  // ================================================================ report view
  async reportView(viewer: Viewer, cid: number) {
    const r = this.report(cid);
    const c = await this.commitmentOnChain(cid);
    const access = await this.contentAccess(viewer, cid);
    this.logAccess(viewer, "read-report", reportRef(cid), access.allowed);
    const isOwner = viewer.id === r.researcher_id;
    const staff = (viewer.kind === "program-admin" || viewer.kind === "reviewer") && viewer.programId === r.program_id;
    let content: any = null;
    if (access.allowed) {
      if (access.scope === "owner") {
        const s = this.openReport(r);
        content = { source: "your sealed original", ...s.fields, privateNotes: s.privateNotes };
      } else {
        const f = this.revealedFields(r)!;
        content = { source: `revealed copy (reveal #${f.revealId}, ${f.outcome ?? `pre-check ${f.precheck}, not yet verified`})`, ...f };
      }
      const ev = this.store.all("SELECT * FROM evidence WHERE cid = ?", cid);
      content.evidenceFiles = ev.map((e) => ({ ...this.evidenceMeta(e, true), committed: (content.evidence as string[]).includes(e.sha256) }));
    }
    const reveals =
      isOwner || staff || viewer.kind === "auditor"
        ? this.store.all("SELECT id, submitted_by, submitted_at, source, precheck, verified_by, verified_at, outcome, reveal_digest, tx_hash FROM reveals WHERE cid = ? ORDER BY id", cid)
        : [];
    const notes = staff
      ? this.store.all("SELECT * FROM notes WHERE cid = ? ORDER BY id", cid).map((n) => ({
          id: n.id,
          author: identityDef(n.author_id)?.label ?? n.author_id,
          createdAt: n.created_at,
          body: this.ctx.vault.open("note", `note:${n.id}`, n.sealed).toString("utf8"),
        }))
      : [];
    const assocs = this.store.all("SELECT aid FROM associations WHERE cid_a = ? OR cid_b = ?", cid, cid);
    const { disputes } = await this.disputesFor(cid);
    const grants = this.store.all("SELECT to_program, granted_by, tx_hash, created_at FROM grants WHERE cid = ?", cid);
    return {
      cid,
      ref: reportRef(cid),
      program: programDef(c.programId),
      researcher: this.labelOf(c.researcher),
      commitment: c.commitment,
      policyVersion: c.policyVersion,
      status: c.status,
      statusName: STATUS[c.status],
      mismatches: c.mismatches,
      revealDigest: c.revealDigest === ZeroHash ? null : c.revealDigest,
      family: c.family === ZeroHash ? null : c.family,
      anchoredAt: iso(c.anchoredAt),
      supersedes: c.supersedes || null,
      supersededBy: c.supersededBy || null,
      tx: { hash: r.tx_hash, blockNumber: r.block_number, gasUsed: r.gas_used },
      logSeq: c.logSeq,
      isOwner,
      isStaff: staff,
      access,
      content,
      reveals,
      notes,
      grants,
      associations: await Promise.all(assocs.map((a) => this.associationView(viewer, a.aid))),
      disputes: disputes.map((d) => this.disputeSummary(d)),
      timeline: this.timelineFor(cid),
    };
  }

  /** Log entries about a report: its own transitions plus association and dispute events. */
  timelineFor(cid: number) {
    const aids = this.store.all("SELECT aid FROM associations WHERE cid_a = ? OR cid_b = ?", cid, cid).map((r) => String(r.aid));
    const dids = this.store.all("SELECT did FROM disputes WHERE cid_a = ? OR cid_b = ?", cid, cid).map((r) => String(r.did));
    const rows = this.store.all("SELECT * FROM chain_events ORDER BY seq");
    return rows
      .filter(
        (e) =>
          ([4, 5, 6, 7, 8, 9, 10, 19].includes(e.kind) && e.subject === String(cid)) ||
          ([11, 12].includes(e.kind) && aids.includes(e.subject)) ||
          ([13, 14, 15, 16, 17, 18].includes(e.kind) && dids.includes(e.subject)),
      )
      .map((e) => this.eventView(e));
  }

  eventView(e: Row) {
    return {
      seq: e.seq,
      kind: e.kind,
      kindName: LOG_KINDS[e.kind] ?? `kind ${e.kind}`,
      subject: e.subject,
      actor: this.labelOf(e.actor),
      at: iso(e.timestamp),
      dataHash: e.data_hash,
      entryHash: e.entry_hash,
      txHash: e.tx_hash,
      blockNumber: e.block_number,
    };
  }

  async myReports(viewer: Viewer) {
    if (viewer.kind !== "researcher") throw new ServiceError("The researcher workspace is for researcher identities.", 403);
    const rows = this.store.all("SELECT * FROM reports WHERE researcher_id = ? ORDER BY cid DESC", viewer.id);
    const out = [];
    for (const r of rows) {
      const c = await this.commitmentOnChain(r.cid);
      const s = this.openReport(r);
      out.push({
        cid: r.cid,
        ref: reportRef(r.cid),
        title: s.fields.title,
        program: programDef(c.programId),
        status: c.status,
        statusName: STATUS[c.status],
        anchoredAt: iso(c.anchoredAt),
        mismatches: c.mismatches,
        supersededBy: c.supersededBy || null,
        supersedes: c.supersedes || null,
        family: c.family === ZeroHash ? null : c.family,
      });
    }
    return { reports: out, pendingEvidence: this.pendingEvidence(viewer), privateIdentity: this.privateIdentity(viewer) };
  }

  // ================================================================ associations
  async proposeAssociation(viewer: Viewer, cidA: number, cidB: number, relation: number, rationale: string) {
    this.report(cidA);
    this.report(cidB);
    const why = text(rationale, "Rationale", LIMITS.rationale);
    const s = salt();
    const digest = noteDigest(why, s);
    const tx = await this.tx(viewer.id, "proposeAssociation", [cidA, cidB, relation, digest]);
    const aid = Number(tx.events.find((e) => e.name === "AssociationProposed")!.args.aid);
    this.store.run(
      "INSERT INTO associations(aid, cid_a, cid_b, relation, status, proposer_id, family, salt, digest, sealed, tx_hash, created_at) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?)",
      aid, cidA, cidB, relation, viewer.id, s, digest, this.ctx.vault.seal("rationale", `assoc:${aid}`, Buffer.from(why)), tx.hash, now(),
    );
    return { aid, tx: tx.hash };
  }

  async reviewAssociation(viewer: Viewer, aid: number, approve: boolean, rationale: string) {
    if (!this.store.get("SELECT aid FROM associations WHERE aid = ?", aid)) throw new ServiceError("Association not found", 404);
    const why = text(rationale, "Review rationale", LIMITS.rationale);
    const s = salt();
    const digest = noteDigest(why, s);
    const tx = await this.tx(viewer.id, "reviewAssociation", [aid, approve, digest]);
    const res = this.store.run(
      "INSERT INTO association_reviews(aid, reviewer_id, approve, salt, digest, sealed, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      aid, viewer.id, approve ? 1 : 0, s, digest, Buffer.alloc(0), tx.hash, now(),
    );
    const id = Number(res.lastInsertRowid);
    this.store.run("UPDATE association_reviews SET sealed = ? WHERE id = ?", this.ctx.vault.seal("rationale", `assoc-review:${id}`, Buffer.from(why)), id);
    await this.refreshAssociation(aid);
    return { tx: tx.hash };
  }

  private async refreshAssociation(aid: number) {
    const s = await this.associationOnChain(aid);
    const fam = (await this.commitmentOnChain(s.cidA)).family;
    this.store.run("UPDATE associations SET status = ?, family = ? WHERE aid = ?", s.status, fam === ZeroHash ? null : fam, aid);
    return s;
  }

  /** Rationales are visible to staff of both programs and to unconflicted arbitrators. */
  private canReadRationale(viewer: Viewer, progs: number[]) {
    if ((viewer.kind === "program-admin" || viewer.kind === "reviewer") && progs.includes(viewer.programId)) return true;
    if (viewer.kind === "arbitrator") return viewer.programId === 0 || !progs.includes(viewer.programId);
    return false;
  }

  async associationView(viewer: Viewer, aid: number) {
    const s = await this.associationOnChain(aid);
    const row = this.store.get("SELECT * FROM associations WHERE aid = ?", aid);
    const [a, b] = await Promise.all([this.commitmentOnChain(s.cidA), this.commitmentOnChain(s.cidB)]);
    const progs = [a.programId, b.programId];
    const readable = row && this.canReadRationale(viewer, progs);
    const effective = Number(await this.ledger.read("effectiveRelation", aid));
    return {
      aid,
      cidA: s.cidA,
      cidB: s.cidB,
      refA: reportRef(s.cidA),
      refB: reportRef(s.cidB),
      programs: progs.map((p) => programDef(p)?.short),
      relation: s.relation,
      relationName: RELATION_NAMES[s.relation],
      effectiveRelation: effective,
      effectiveRelationName: effective ? RELATION_NAMES[effective] : "none",
      status: s.status,
      statusName: ASSOC_STATUS[s.status],
      decidedRelation: s.decidedRelation,
      family: a.family !== ZeroHash && a.family === b.family ? a.family : null,
      proposer: this.labelOf(s.proposer),
      reviewer: s.reviewer === "0x0000000000000000000000000000000000000000" ? null : this.labelOf(s.reviewer),
      rationaleDigest: row?.digest ?? null,
      rationale: readable ? this.ctx.vault.open("rationale", `assoc:${aid}`, row!.sealed).toString("utf8") : null,
      reviews: this.store.all("SELECT * FROM association_reviews WHERE aid = ? ORDER BY id", aid).map((rv) => ({
        reviewer: identityDef(rv.reviewer_id)?.label ?? rv.reviewer_id,
        approve: !!rv.approve,
        digest: rv.digest,
        rationale: readable ? this.ctx.vault.open("rationale", `assoc-review:${rv.id}`, rv.sealed).toString("utf8") : null,
        tx: rv.tx_hash,
        at: rv.created_at,
      })),
      tx: row?.tx_hash ?? null,
    };
  }

  // ================================================================ disputes
  async openDispute(viewer: Viewer, kind: number, subject: number, statement: string) {
    const st = text(statement, "Statement", LIMITS.rationale);
    const s = salt();
    const digest = noteDigest(st, s);
    const tx = await this.tx(viewer.id, "openDispute", [kind, subject, digest]);
    const did = Number(tx.events.find((e) => e.name === "DisputeOpened")!.args.did);
    const d = await this.disputeOnChain(did);
    this.store.run(
      `INSERT INTO disputes(did, kind, subject, cid_a, cid_b, opener_id, status, round, decision, reason_code, first_decision, first_reason,
         reversed, policy_digest, salt, digest, sealed, opened_at, decided_at, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, NULL, ?)`,
      did, kind, subject, d.cidA, d.cidB || null, viewer.id, d.status, d.round, d.policyDigest, s, digest,
      this.ctx.vault.seal("rationale", `dispute:${did}`, Buffer.from(st)), d.openedAt, tx.hash,
    );
    if (kind === 1) await this.refreshAssociation(subject);
    return { did, tx: tx.hash };
  }

  /** Run a dispute transaction and keep the (sealed) rationale whose salted digest went on-chain. */
  private async act(viewer: Viewer, did: number, act: string, method: string, args: unknown[], fields: { decision?: number; reason?: number; rationale?: string; salt?: string }) {
    if (!this.store.get("SELECT did FROM disputes WHERE did = ?", did)) throw new ServiceError("Dispute not found", 404);
    const before = await this.disputeOnChain(did);
    const tx = await this.tx(viewer.id, method, args);
    const digest = fields.rationale && fields.salt ? noteDigest(fields.rationale, fields.salt) : null;
    const res = this.store.run(
      "INSERT INTO dispute_acts(did, act, round, actor_id, decision, reason_code, salt, digest, sealed, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      did, act, before.round, viewer.id, fields.decision ?? null, fields.reason ?? null, fields.salt ?? null, digest, tx.hash, now(),
    );
    const id = Number(res.lastInsertRowid);
    if (fields.rationale) this.store.run("UPDATE dispute_acts SET sealed = ? WHERE id = ?", this.ctx.vault.seal("rationale", `act:${id}`, Buffer.from(fields.rationale)), id);
    await this.refreshDispute(did);
    return { tx: tx.hash, events: tx.events.map((e) => e.name) };
  }

  vote(viewer: Viewer, did: number, decision: number, reasonCode: number, rationale: string) {
    if (!REASON_CODES[reasonCode]) throw new ServiceError("Unknown reason code", 422);
    const why = text(rationale, "Rationale", LIMITS.rationale);
    const s = salt();
    return this.act(viewer, did, "vote", "vote", [did, decision, reasonCode, noteDigest(why, s)], { decision, reason: reasonCode, rationale: why, salt: s });
  }

  recuse(viewer: Viewer, did: number) {
    return this.act(viewer, did, "recuse", "recuse", [did], {});
  }

  appeal(viewer: Viewer, did: number, statement: string) {
    const why = text(statement, "Appeal statement", LIMITS.rationale);
    const s = salt();
    return this.act(viewer, did, "appeal", "appeal", [did, noteDigest(why, s)], { rationale: why, salt: s });
  }

  closeDispute(viewer: Viewer, did: number) {
    return this.act(viewer, did, "close", "closeDispute", [did], {});
  }

  private async refreshDispute(did: number) {
    const d = await this.disputeOnChain(did);
    this.store.run(
      "UPDATE disputes SET status = ?, round = ?, decision = ?, reason_code = ?, first_decision = ?, first_reason = ?, reversed = ?, decided_at = ? WHERE did = ?",
      d.status, d.round, d.decision || null, d.reasonCode || null, d.firstDecision || null, d.firstReason || null, d.reversed ? 1 : 0, d.decidedAt || null, did,
    );
    if (d.kind === 1 || d.kind === 2) await this.refreshAssociation(d.subject);
    for (const cid of [d.cidA, d.cidB]) if (cid) await this.refreshReport(cid);
    return d;
  }

  disputeSummary(d: ChainDispute) {
    return {
      did: d.did,
      kind: d.kind,
      kindName: DISPUTE_KIND_NAMES[d.kind],
      status: d.status,
      statusName: DISPUTE_STATUS[d.status],
      round: d.round,
      subject: d.subject,
      refs: [d.cidA, d.cidB].filter(Boolean).map(reportRef),
      programs: [d.progA, d.progB].filter(Boolean).map((p) => programDef(p)?.short),
      decision: d.decision || null,
      decisionName: d.decision ? DECISION_NAMES[d.decision] : null,
      reasonCode: d.reasonCode || null,
      openedAt: iso(d.openedAt),
      decidedAt: iso(d.decidedAt),
    };
  }

  async disputes() {
    const rows = this.store.all("SELECT did FROM disputes ORDER BY did DESC");
    return Promise.all(rows.map(async (r) => this.disputeSummary(await this.disputeOnChain(r.did))));
  }

  async disputeView(viewer: Viewer, did: number) {
    const row = this.store.get("SELECT * FROM disputes WHERE did = ?", did);
    if (!row) throw new ServiceError("Dispute not found", 404);
    const d = await this.disputeOnChain(did);
    const progs = [d.progA, d.progB].filter(Boolean);
    const researchers = [d.cidA, d.cidB].filter(Boolean).map((cid) => this.store.get("SELECT researcher_id FROM reports WHERE cid = ?", cid)?.researcher_id);
    const isParty = researchers.includes(viewer.id) || ((viewer.kind === "program-admin" || viewer.kind === "reviewer") && progs.includes(viewer.programId));
    const readable = isParty || this.canReadRationale(viewer, progs);
    const conflicted = viewer.kind === "arbitrator" && viewer.programId !== 0 && progs.includes(viewer.programId);
    const appealDeadline = d.decidedAt ? d.decidedAt + Number(await this.ledger.read("appealWindow")) : null;
    const policy = this.store.get("SELECT * FROM policies WHERE program_id = ? AND digest = ?", d.progA, d.policyDigest);
    return {
      ...this.disputeSummary(d),
      opener: this.labelOf(d.opener),
      openerId: row.opener_id,
      statement: readable ? this.ctx.vault.open("rationale", `dispute:${did}`, row.sealed).toString("utf8") : null,
      statementDigest: row.digest,
      firstDecision: d.firstDecision || null,
      firstDecisionName: d.firstDecision ? DECISION_NAMES[d.firstDecision] : null,
      firstReason: d.firstReason || null,
      reversed: d.reversed,
      priorityTo: d.priorityTo ? reportRef(d.priorityTo) : null,
      policy: { digest: d.policyDigest, programId: d.progA, version: policy?.version ?? null, title: policy ? String(policy.body).split("\n")[0] : null },
      appealDeadline: appealDeadline ? iso(appealDeadline) : null,
      appealOpen: d.status === 2 && appealDeadline !== null && Date.now() / 1000 <= appealDeadline,
      threshold: Number(await this.ledger.read("threshold")),
      viewerIsParty: isParty,
      viewerConflicted: conflicted,
      association: d.kind !== 3 ? await this.associationView(viewer, d.subject) : null,
      acts: this.store.all("SELECT * FROM dispute_acts WHERE did = ? ORDER BY id", did).map((a) => ({
        act: a.act,
        round: a.round,
        actor: identityDef(a.actor_id)?.label ?? a.actor_id,
        decision: a.decision,
        decisionName: a.decision ? DECISION_NAMES[a.decision] : null,
        reasonCode: a.reason_code,
        reason: a.reason_code ? REASON_CODES[a.reason_code] : null,
        digest: a.digest,
        rationale: readable && a.sealed ? this.ctx.vault.open("rationale", `act:${a.id}`, a.sealed).toString("utf8") : null,
        tx: a.tx_hash,
        at: a.created_at,
      })),
      timeline: this.store.all("SELECT * FROM chain_events WHERE kind IN (13,14,15,16,17,18) AND subject = ? ORDER BY seq", String(did)).map((e) => this.eventView(e)),
    };
  }

  // ================================================================ overview
  async explorer() {
    const snap = await this.snapshot();
    const reveals = new Map<number, Row[]>();
    for (const r of this.store.all("SELECT cid, outcome, precheck FROM reveals")) reveals.set(r.cid, [...(reveals.get(r.cid) ?? []), r]);
    return {
      commitments: snap.commitments.map((c) => ({
        cid: c.cid,
        ref: reportRef(c.cid),
        program: programDef(c.programId)?.short,
        programId: c.programId,
        researcher: this.labelOf(c.researcher),
        commitment: c.commitment,
        anchoredAt: iso(c.anchoredAt),
        status: c.status,
        statusName: STATUS[c.status],
        revealState: c.status >= ST.REVEALED ? "verified match" : c.mismatches ? `${c.mismatches} failed reveal check(s)` : reveals.has(c.cid) ? "revealed, awaiting verification" : "not revealed",
        family: c.family === ZeroHash ? null : c.family,
        supersedes: c.supersedes || null,
        supersededBy: c.supersededBy || null,
      })),
      associations: snap.associations.map((s) => ({
        aid: s.aid,
        refA: reportRef(s.cidA),
        refB: reportRef(s.cidB),
        relationName: RELATION_NAMES[s.relation],
        statusName: ASSOC_STATUS[s.status],
        decidedRelationName: s.decidedRelation ? RELATION_NAMES[s.decidedRelation] : null,
        proposer: this.labelOf(s.proposer).label,
        reviewer: s.reviewer === "0x0000000000000000000000000000000000000000" ? null : this.labelOf(s.reviewer).label,
      })),
      disputes: snap.disputes.map((d) => this.disputeSummary(d)),
    };
  }

  async dashboard() {
    const snap = await this.snapshot();
    const researchers = await Promise.all(
      IDENTITY_DEFS.filter((d) => d.kind === "researcher").map(async (d) => Number((await this.ledger.read("participants", this.ctx.keyring.address(d.id))).roles) & ROLE.RESEARCHER),
    );
    const live = snap.commitments.filter((c) => !c.supersededBy);
    const recent = this.store.all("SELECT * FROM chain_events ORDER BY seq DESC LIMIT 14").map((e) => this.eventView(e));
    return {
      totals: {
        researchers: researchers.filter(Boolean).length,
        programs: Number(await this.ledger.read("programCount")),
        commitments: snap.commitments.length,
        revealed: live.filter((c) => c.status >= ST.REVEALED).length,
        unrevealed: live.filter((c) => c.status < ST.REVEALED).length,
        awaitingTriage: live.filter((c) => c.status === ST.REVEALED || c.status === ST.PENDING_TRIAGE || c.status === ST.NEEDS_INFO).length,
        openDisputes: snap.disputes.filter((d) => d.status !== 4).length,
        openCrossProgram: snap.disputes.filter((d) => d.status !== 4 && d.progB !== 0).length,
        completedArbitrations: snap.disputes.filter((d) => d.status === 4).length,
        associations: snap.associations.length,
        logEntries: Number(await this.ledger.read("logCount")),
      },
      chain: {
        contract: this.ledger.address,
        chainId: this.ledger.chainId,
        rpcUrl: this.ledger.rpcUrl,
        blockNumber: await this.ledger.provider.getBlockNumber(),
        logHead: await this.ledger.read("logHead"),
      },
      recent,
    };
  }

  auditEvents(limit = 200) {
    return this.store.all("SELECT * FROM chain_events ORDER BY seq DESC LIMIT ?", limit).map((e) => this.eventView(e));
  }

  accessLog(viewer: Viewer, limit = 100) {
    if (viewer.kind !== "auditor" && viewer.kind !== "governor") throw new ServiceError("The access log is visible to auditors.", 403);
    return this.store.all("SELECT * FROM access_log ORDER BY id DESC LIMIT ?", limit);
  }

  async programs() {
    return Promise.all(
      PROGRAMS.map(async (p) => {
        const onchain = await this.ledger.read("programs", p.id);
        const policies = this.store.all("SELECT version, digest, body, published_at FROM policies WHERE program_id = ? ORDER BY version", p.id);
        return { ...p, active: Boolean(onchain.active), policyVersion: Number(onchain.policyVersion), policies };
      }),
    );
  }

  /** Verify a receipt (and optionally a reveal package) against the chain — no login needed. */
  verifyReceipt(receipt: unknown, reveal?: unknown) {
    return verifyReceipt(receipt, this.ledger.provider, reveal);
  }
}

export { LedgerError };
