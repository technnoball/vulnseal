// Centralised baselines for the VulnSeal benchmark.
//
// EditableDesign  - a conventional submission database: rows are updated in place, an
//                   (editable) status log, unsigned receipts checked against the database.
// HardenedDesign  - append-only application semantics: every event is an entry in a
//                   SHA-256 hash chain, signed with the operator's Ed25519 key; UPDATE and
//                   DELETE are blocked by triggers; receipts are operator-signed. With
//                   `anchored`, the head hash and count are handed to an independent party
//                   after every write (external checkpoints).
//
// Both use the same commitment construction and the same role rules as the contract, and
// seal report content with the same vault, so differences come from where integrity and
// authorisation are enforced, not from weaker logic.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "../../server/canonical.ts";
import { checkReveal } from "../../server/commitment.ts";
import { DECISIONS_FOR_KIND, IDENTITY_DEFS, ST } from "../../server/domain.ts";

export const OPERATOR_CONTRACT = "0x0000000000000000000000000000000000000001";
export const OFFCHAIN_CHAIN_ID = 0;

const def = (id: string) => IDENTITY_DEFS.find((d) => d.id === id)!;
const staff = (id: string) => ["program-admin", "reviewer"].includes(def(id)?.kind);

export class Rejected extends Error {}
const deny = (why: string): never => {
  throw new Rejected(why);
};

/** The contract's rules, evaluated in application code. */
export const rules = {
  commit: (actor: string) => def(actor)?.kind === "researcher" || deny("NotAuthorized"),
  staffOf: (actor: string, program: number) => (staff(actor) && def(actor).programId === program) || deny("WrongProgram"),
  transition(from: number, to: number) {
    const ok =
      (from === ST.ANCHORED && to === ST.ACKNOWLEDGED) ||
      (from === ST.ACKNOWLEDGED && to === ST.REVEAL_REQUESTED) ||
      (from === ST.REVEAL_REQUESTED && to === ST.REVEALED) ||
      (from === ST.REVEALED && to === ST.PENDING_TRIAGE) ||
      (from === ST.PENDING_TRIAGE && [ST.NEEDS_INFO, ST.VALID, ST.INVALID].includes(to as any)) ||
      (from === ST.NEEDS_INFO && [ST.PENDING_TRIAGE, ST.VALID, ST.INVALID].includes(to as any));
    return ok || deny("InvalidTransition");
  },
  arbitrator(actor: string, programs: number[], researchers: string[]) {
    const d = def(actor);
    if (d?.kind !== "arbitrator") deny("NotAuthorized");
    if (d.programId !== 0 && programs.includes(d.programId)) deny("ConflictedArbitrator");
    if (researchers.includes(actor)) deny("PartyCannotVote");
    return true;
  },
};

export interface Sub {
  id: number;
  program: number;
  researcher: string;
  researcherAddress: string;
  commitment: string;
  status: number;
  createdAt: number;
  mismatches: number;
}

export interface Receipt {
  id: number;
  program: number;
  researcher: string;
  commitment: string;
  createdAt: number;
  seq?: number;
  hash?: string;
  sig?: string;
}

function dbSize(db: DatabaseSync) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return (db.prepare("PRAGMA page_count").get() as any).page_count * (db.prepare("PRAGMA page_size").get() as any).page_size;
}

const now = () => Math.floor(Date.now() / 1000);

// ============================================================================ editable
export class EditableDesign {
  readonly id = "editable";
  readonly db: DatabaseSync;
  readonly file: string;
  events = 0;
  constructor(dir: string) {
    this.file = path.join(dir, "editable.sqlite");
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE submissions (id INTEGER PRIMARY KEY, program INT, researcher TEXT, researcher_address TEXT, commitment TEXT, status INT, created_at INT, mismatches INT DEFAULT 0, sealed BLOB);
      CREATE TABLE status_log (id INTEGER PRIMARY KEY, sid INT, from_status INT, to_status INT, actor TEXT, at INT);
      CREATE TABLE associations (id INTEGER PRIMARY KEY, a INT, b INT, relation INT, status TEXT, proposer TEXT, reviewer TEXT, family TEXT);
      CREATE TABLE disputes (id INTEGER PRIMARY KEY, kind INT, subject INT, a INT, b INT, status TEXT, round INT, decision INT, reason INT, opener TEXT);
      CREATE TABLE votes (id INTEGER PRIMARY KEY, did INT, round INT, arbitrator TEXT, decision INT, reason INT);`);
  }
  sub(id: number): Sub | undefined {
    const r = this.db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as any;
    return r && { id: r.id, program: r.program, researcher: r.researcher, researcherAddress: r.researcher_address, commitment: r.commitment, status: r.status, createdAt: r.created_at, mismatches: r.mismatches };
  }
  commit(actor: string, address: string, program: number, commitment: string, sealed: Uint8Array): Receipt {
    rules.commit(actor);
    const t = now();
    const r = this.db.prepare("INSERT INTO submissions(program, researcher, researcher_address, commitment, status, created_at, sealed) VALUES (?, ?, ?, ?, ?, ?, ?)").run(program, actor, address, commitment, ST.ANCHORED, t, sealed);
    this.events++;
    return { id: Number(r.lastInsertRowid), program, researcher: actor, commitment, createdAt: t };
  }
  move(actor: string, id: number, to: number) {
    const s = this.sub(id) ?? deny("UnknownCommitment");
    rules.staffOf(actor, s.program);
    rules.transition(s.status, to);
    this.db.prepare("UPDATE submissions SET status = ? WHERE id = ?").run(to, id);
    this.db.prepare("INSERT INTO status_log(sid, from_status, to_status, actor, at) VALUES (?, ?, ?, ?, ?)").run(id, s.status, to, actor, now());
    this.events++;
  }
  /** Same read rule as VulnSeal: the researcher, or the program's staff once revealed. */
  canRead(actor: string, id: number) {
    const s = this.sub(id)!;
    return s.researcher === actor || (staff(actor) && def(actor).programId === s.program && s.status >= ST.REVEALED);
  }
  /** Conventional edit: the submission is updated in place (the earlier commitment is gone). */
  revise(actor: string, id: number, commitment: string, sealed: Uint8Array) {
    const s = this.sub(id) ?? deny("UnknownCommitment");
    if (s.researcher !== actor) deny("NotCommitmentOwner");
    this.db.prepare("UPDATE submissions SET commitment = ?, sealed = ? WHERE id = ?").run(commitment, sealed, id);
    this.events++;
    return id;
  }
  /** Program reviewer checks a reveal against the stored commitment and records the result. */
  reveal(actor: string, id: number, pkg: unknown) {
    const s = this.sub(id) ?? deny("UnknownCommitment");
    rules.staffOf(actor, s.program);
    if (s.status !== ST.REVEAL_REQUESTED) deny("InvalidTransition");
    const chk = checkReveal(pkg, { cid: id, commitment: s.commitment, chainId: OFFCHAIN_CHAIN_ID, contract: OPERATOR_CONTRACT, researcher: s.researcherAddress, programId: s.program, policyVersion: 1 });
    if (chk.outcome === "match") this.move(actor, id, ST.REVEALED);
    else {
      this.db.prepare("UPDATE submissions SET mismatches = mismatches + 1 WHERE id = ?").run(id);
      this.db.prepare("INSERT INTO status_log(sid, from_status, to_status, actor, at) VALUES (?, ?, ?, ?, ?)").run(id, s.status, -1, actor, now());
      this.events++;
    }
    return chk.outcome;
  }
  propose(actor: string, a: number, b: number, relation: number) {
    const sa = this.sub(a)!, sb = this.sub(b)!;
    if (sa.program === sb.program) deny("SameProgram");
    if (!(staff(actor) && [sa.program, sb.program].includes(def(actor).programId))) deny("WrongProgram");
    if (sa.status < ST.REVEALED || sb.status < ST.REVEALED) deny("RevealRequired");
    this.events++;
    return Number(this.db.prepare("INSERT INTO associations(a, b, relation, status, proposer) VALUES (?, ?, ?, 'proposed', ?)").run(a, b, relation, actor).lastInsertRowid);
  }
  review(actor: string, aid: number, approve: boolean) {
    const s = this.db.prepare("SELECT * FROM associations WHERE id = ?").get(aid) as any;
    if (s.status !== "proposed") deny("AssociationNotPending");
    const other = def(s.proposer).programId === this.sub(s.a)!.program ? this.sub(s.b)!.program : this.sub(s.a)!.program;
    if (actor === s.proposer) deny("ProposerCannotReview");
    rules.staffOf(actor, other);
    const family = approve && s.relation === 1 ? createHash("sha256").update(`family:${aid}`).digest("hex") : null;
    this.db.prepare("UPDATE associations SET status = ?, reviewer = ?, family = ? WHERE id = ?").run(approve ? "confirmed" : "rejected", actor, family, aid);
    this.events++;
    return family;
  }
  association(aid: number) {
    return this.db.prepare("SELECT * FROM associations WHERE id = ?").get(aid) as any;
  }
  openDispute(actor: string, kind: number, aid: number) {
    const s = this.association(aid);
    const parties = [this.sub(s.a)!, this.sub(s.b)!];
    if (!parties.some((p) => p.researcher === actor || (staff(actor) && def(actor).programId === p.program))) deny("NotAParty");
    this.events++;
    return Number(this.db.prepare("INSERT INTO disputes(kind, subject, a, b, status, round, opener) VALUES (?, ?, ?, ?, 'open', 1, ?)").run(kind, aid, s.a, s.b, actor).lastInsertRowid);
  }
  dispute(did: number) {
    return this.db.prepare("SELECT * FROM disputes WHERE id = ?").get(did) as any;
  }
  vote(actor: string, did: number, decision: number, reason: number) {
    const d = this.dispute(did);
    if (!["open", "appealed"].includes(d.status)) deny("NotOpenForVoting");
    const parties = [this.sub(d.a)!, this.sub(d.b)!];
    rules.arbitrator(actor, parties.map((p) => p.program), parties.map((p) => p.researcher));
    if (this.db.prepare("SELECT 1 FROM votes WHERE did = ? AND round = ? AND arbitrator = ?").get(did, d.round, actor)) deny("AlreadyVoted");
    if (d.round === 2 && this.db.prepare("SELECT 1 FROM votes WHERE did = ? AND round = 1 AND arbitrator = ?").get(did, actor)) deny("PriorPanelMember");
    if (!DECISIONS_FOR_KIND[d.kind].includes(decision)) deny("InvalidDecision");
    this.db.prepare("INSERT INTO votes(did, round, arbitrator, decision, reason) VALUES (?, ?, ?, ?, ?)").run(did, d.round, actor, decision, reason);
    this.events++;
    const n = (this.db.prepare("SELECT COUNT(*) n FROM votes WHERE did = ? AND round = ? AND decision = ? AND reason = ?").get(did, d.round, decision, reason) as any).n;
    if (n >= 2) this.db.prepare("UPDATE disputes SET status = ?, decision = ?, reason = ? WHERE id = ?").run(d.round === 1 ? "decided" : "final", decision, reason, did);
  }
  appeal(actor: string, did: number) {
    const d = this.dispute(did);
    if (d.status !== "decided") deny("NotDecided");
    if (![this.sub(d.a)!, this.sub(d.b)!].some((p) => p.researcher === actor || (staff(actor) && def(actor).programId === p.program))) deny("NotAParty");
    this.db.prepare("UPDATE disputes SET status = 'appealed', round = 2 WHERE id = ?").run(did);
    this.events++;
  }
  /** Decisions per round, as an auditor can reconstruct them from this store. */
  decisionHistory(did: number): Record<number, number | null> {
    const out: Record<number, number | null> = {};
    for (const round of [1, 2]) {
      const rows = this.db.prepare("SELECT decision, reason, COUNT(*) n FROM votes WHERE did = ? AND round = ? GROUP BY decision, reason").all(did, round) as any[];
      out[round] = rows.find((r) => r.n >= 2)?.decision ?? null;
    }
    return out;
  }
  receipt(id: number): Receipt {
    const s = this.sub(id)!;
    return { id, program: s.program, researcher: s.researcher, commitment: s.commitment, createdAt: s.createdAt };
  }
  /** A verifier can only compare an (unsigned) receipt with the operator's database. */
  verifyReceipt(r: Partial<Receipt>): boolean {
    if (!r.id || !r.commitment || !r.createdAt || !r.program) return false;
    const s = this.sub(r.id);
    return !!s && s.commitment === r.commitment && s.createdAt === r.createdAt && s.program === r.program;
  }
  /** Consistency checks available to a conventional store. */
  audit(): string[] {
    const out: string[] = [];
    for (const s of this.db.prepare("SELECT id, status FROM submissions").all() as any[]) {
      const last = this.db.prepare("SELECT to_status FROM status_log WHERE sid = ? AND to_status >= 0 ORDER BY id DESC LIMIT 1").get(s.id) as any;
      if ((last?.to_status ?? ST.ANCHORED) !== s.status) out.push(`status of #${s.id} disagrees with its log`);
    }
    return out;
  }
  size() {
    return dbSize(this.db);
  }
}

// ============================================================================ hardened
interface Entry {
  seq: number;
  kind: string;
  subject: number;
  actor: string;
  data: string;
  ts: number;
  prev: string;
  hash: string;
  sig: string;
}

export class HardenedDesign {
  readonly id: string;
  readonly db: DatabaseSync;
  readonly anchored: boolean;
  readonly operatorPublic: KeyObject;
  private operatorPrivate: KeyObject;
  /** Every head handed to the independent party (a witness keeps all of them, like a transparency-log witness). */
  checkpoints: { count: number; head: string }[] = [];
  private checkpointFile: string;
  constructor(dir: string, anchored: boolean) {
    this.id = anchored ? "hardened-anchored" : "hardened";
    this.anchored = anchored;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.operatorPublic = publicKey;
    this.operatorPrivate = privateKey;
    this.checkpointFile = path.join(dir, `${this.id}-checkpoint.json`);
    this.db = new DatabaseSync(path.join(dir, `${this.id}.sqlite`));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE entries (seq INTEGER PRIMARY KEY, kind TEXT, subject INT, actor TEXT, data TEXT, ts INT, prev TEXT, hash TEXT, sig TEXT);
      CREATE INDEX entries_subject ON entries(kind, subject);
      CREATE TABLE sealed (id INTEGER PRIMARY KEY, body BLOB);`);
    this.addTriggers();
  }
  get events() {
    return (this.db.prepare("SELECT COUNT(*) n FROM entries").get() as any).n as number;
  }
  addTriggers() {
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'append-only'); END;`);
  }
  dropTriggers() {
    this.db.exec("DROP TRIGGER IF EXISTS no_update; DROP TRIGGER IF EXISTS no_delete;");
  }
  static hashOf(e: Omit<Entry, "hash" | "sig">) {
    return createHash("sha256").update(canonicalize({ seq: e.seq, kind: e.kind, subject: e.subject, actor: e.actor, data: e.data, ts: e.ts, prev: e.prev })).digest("hex");
  }
  private signHash(h: string) {
    return sign(null, Buffer.from(h, "hex"), this.operatorPrivate).toString("base64");
  }
  private append(kind: string, subject: number, actor: string, data: Record<string, unknown>, ts = now()): Entry {
    const last = this.db.prepare("SELECT seq, hash FROM entries ORDER BY seq DESC LIMIT 1").get() as any;
    const e = { seq: (last?.seq ?? 0) + 1, kind, subject, actor, data: canonicalize(data), ts, prev: last?.hash ?? "0".repeat(64) };
    const hash = HardenedDesign.hashOf(e);
    const full = { ...e, hash, sig: this.signHash(hash) };
    this.db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(full.seq, kind, subject, actor, full.data, ts, full.prev, hash, full.sig);
    if (this.anchored) {
      this.checkpoints.push({ count: full.seq, head: hash });
      fs.appendFileSync(this.checkpointFile, JSON.stringify({ count: full.seq, head: hash }) + "\n");
    }
    return full;
  }
  entries(): Entry[] {
    return this.db.prepare("SELECT * FROM entries ORDER BY seq").all() as any;
  }
  /** Current state as a verifier would derive it by replaying the log. */
  sub(id: number): Sub | undefined {
    const rows = this.db.prepare("SELECT * FROM entries WHERE subject = ? AND kind IN ('commit','status','mismatch') ORDER BY seq").all(id) as any[];
    const c = rows.find((r) => r.kind === "commit");
    if (!c) return undefined;
    const d = JSON.parse(c.data);
    const statuses = rows.filter((r) => r.kind === "status").map((r) => JSON.parse(r.data).to);
    return {
      id,
      program: d.program,
      researcher: c.actor,
      researcherAddress: d.address,
      commitment: d.commitment,
      status: statuses.length ? statuses[statuses.length - 1] : ST.ANCHORED,
      createdAt: c.ts,
      mismatches: rows.filter((r) => r.kind === "mismatch").length,
    };
  }
  commit(actor: string, address: string, program: number, commitment: string, sealed: Uint8Array): Receipt {
    rules.commit(actor);
    const id = Number(this.db.prepare("INSERT INTO sealed(body) VALUES (?)").run(sealed).lastInsertRowid);
    const e = this.append("commit", id, actor, { program, commitment, address });
    return { id, program, researcher: actor, commitment, createdAt: e.ts, seq: e.seq, hash: e.hash, sig: e.sig };
  }
  move(actor: string, id: number, to: number) {
    const s = this.sub(id) ?? deny("UnknownCommitment");
    rules.staffOf(actor, s.program);
    rules.transition(s.status, to);
    this.append("status", id, actor, { from: s.status, to });
  }
  canRead(actor: string, id: number) {
    const s = this.sub(id)!;
    return s.researcher === actor || (staff(actor) && def(actor).programId === s.program && s.status >= ST.REVEALED);
  }
  /** Revision = a new commitment entry referencing the original, which stays in the log. */
  revise(actor: string, id: number, commitment: string, sealed: Uint8Array) {
    const s = this.sub(id) ?? deny("UnknownCommitment");
    if (s.researcher !== actor) deny("NotCommitmentOwner");
    const r = this.commit(actor, s.researcherAddress, s.program, commitment, sealed);
    this.append("supersede", id, actor, { by: r.id });
    return r.id;
  }
  reveal(actor: string, id: number, pkg: unknown) {
    const s = this.sub(id) ?? deny("UnknownCommitment");
    rules.staffOf(actor, s.program);
    if (s.status !== ST.REVEAL_REQUESTED) deny("InvalidTransition");
    const chk = checkReveal(pkg, { cid: id, commitment: s.commitment, chainId: OFFCHAIN_CHAIN_ID, contract: OPERATOR_CONTRACT, researcher: s.researcherAddress, programId: s.program, policyVersion: 1 });
    if (chk.outcome === "match") this.move(actor, id, ST.REVEALED);
    else this.append("mismatch", id, actor, { outcome: chk.outcome });
    return chk.outcome;
  }
  association(aid: number) {
    const p = this.db.prepare("SELECT * FROM entries WHERE kind = 'assoc' AND subject = ?").get(aid) as any;
    if (!p) return undefined;
    const d = JSON.parse(p.data);
    const rv = this.db.prepare("SELECT * FROM entries WHERE kind = 'review' AND subject = ? ORDER BY seq DESC LIMIT 1").get(aid) as any;
    const r = rv ? JSON.parse(rv.data) : null;
    return { id: aid, a: d.a, b: d.b, relation: d.relation, proposer: p.actor, status: r ? (r.approve ? "confirmed" : "rejected") : "proposed", reviewer: rv?.actor ?? null, family: r?.family ?? null };
  }
  propose(actor: string, a: number, b: number, relation: number) {
    const sa = this.sub(a)!, sb = this.sub(b)!;
    if (sa.program === sb.program) deny("SameProgram");
    if (!(staff(actor) && [sa.program, sb.program].includes(def(actor).programId))) deny("WrongProgram");
    if (sa.status < ST.REVEALED || sb.status < ST.REVEALED) deny("RevealRequired");
    const aid = (this.db.prepare("SELECT COUNT(*) n FROM entries WHERE kind = 'assoc'").get() as any).n + 1;
    this.append("assoc", aid, actor, { a, b, relation });
    return aid;
  }
  review(actor: string, aid: number, approve: boolean) {
    const s = this.association(aid)!;
    if (s.status !== "proposed") deny("AssociationNotPending");
    if (actor === s.proposer) deny("ProposerCannotReview");
    const other = def(s.proposer).programId === this.sub(s.a)!.program ? this.sub(s.b)!.program : this.sub(s.a)!.program;
    rules.staffOf(actor, other);
    const family = approve && s.relation === 1 ? createHash("sha256").update(`family:${aid}`).digest("hex") : null;
    this.append("review", aid, actor, { approve, family });
    return family;
  }
  dispute(did: number) {
    const o = this.db.prepare("SELECT * FROM entries WHERE kind = 'dispute' AND subject = ?").get(did) as any;
    const d = JSON.parse(o.data);
    const acts = this.db.prepare("SELECT * FROM entries WHERE kind IN ('vote','appeal') AND subject = ? ORDER BY seq").all(did) as any[];
    let round = 1;
    let status = "open";
    let decision: number | null = null;
    const tally = new Map<string, number>();
    for (const a of acts) {
      if (a.kind === "appeal") {
        round = 2;
        status = "appealed";
        tally.clear();
        continue;
      }
      const v = JSON.parse(a.data);
      const k = `${v.round}:${v.decision}:${v.reason}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
      if (tally.get(k)! >= 2 && v.round === round) {
        status = round === 1 ? "decided" : "final";
        decision = v.decision;
      }
    }
    return { id: did, kind: d.kind, subject: d.subject, a: d.a, b: d.b, round, status, decision, acts };
  }
  openDispute(actor: string, kind: number, aid: number) {
    const s = this.association(aid)!;
    const parties = [this.sub(s.a)!, this.sub(s.b)!];
    if (!parties.some((p) => p.researcher === actor || (staff(actor) && def(actor).programId === p.program))) deny("NotAParty");
    const did = (this.db.prepare("SELECT COUNT(*) n FROM entries WHERE kind = 'dispute'").get() as any).n + 1;
    this.append("dispute", did, actor, { kind, subject: aid, a: s.a, b: s.b });
    return did;
  }
  vote(actor: string, did: number, decision: number, reason: number) {
    const d = this.dispute(did);
    if (!["open", "appealed"].includes(d.status)) deny("NotOpenForVoting");
    const parties = [this.sub(d.a)!, this.sub(d.b)!];
    rules.arbitrator(actor, parties.map((p) => p.program), parties.map((p) => p.researcher));
    const voted = (round: number) => d.acts.some((a: any) => a.kind === "vote" && a.actor === actor && JSON.parse(a.data).round === round);
    if (voted(d.round)) deny("AlreadyVoted");
    if (d.round === 2 && voted(1)) deny("PriorPanelMember");
    if (!DECISIONS_FOR_KIND[d.kind].includes(decision)) deny("InvalidDecision");
    this.append("vote", did, actor, { round: d.round, decision, reason });
  }
  appeal(actor: string, did: number) {
    const d = this.dispute(did);
    if (d.status !== "decided") deny("NotDecided");
    if (![this.sub(d.a)!, this.sub(d.b)!].some((p) => p.researcher === actor || (staff(actor) && def(actor).programId === p.program))) deny("NotAParty");
    this.append("appeal", did, actor, {});
  }
  decisionHistory(did: number): Record<number, number | null> {
    const d = this.dispute(did);
    const out: Record<number, number | null> = { 1: null, 2: null };
    for (const round of [1, 2]) {
      const t = new Map<string, number>();
      for (const a of d.acts.filter((x: any) => x.kind === "vote" && JSON.parse(x.data).round === round)) {
        const v = JSON.parse(a.data);
        const k = `${v.decision}:${v.reason}`;
        t.set(k, (t.get(k) ?? 0) + 1);
        if (t.get(k)! >= 2) out[round] = v.decision;
      }
    }
    return out;
  }
  receipt(id: number): Receipt {
    const c = this.db.prepare("SELECT * FROM entries WHERE kind = 'commit' AND subject = ?").get(id) as any;
    const d = JSON.parse(c.data);
    return { id, program: d.program, researcher: c.actor, commitment: d.commitment, createdAt: c.ts, seq: c.seq, hash: c.hash, sig: c.sig };
  }
  /** Signature by the operator, entry present and recomputing, and (anchored) consistent with the checkpoint. */
  verifyReceipt(r: Partial<Receipt>): boolean {
    if (!r.id || !r.commitment || !r.createdAt || !r.program || !r.seq || !r.hash || !r.sig) return false;
    if (!verify(null, Buffer.from(r.hash, "hex"), this.operatorPublic, Buffer.from(r.sig, "base64"))) return false;
    const e = this.db.prepare("SELECT * FROM entries WHERE seq = ?").get(r.seq) as any;
    if (!e || e.hash !== r.hash || HardenedDesign.hashOf(e) !== e.hash) return false;
    const d = JSON.parse(e.data);
    if (d.commitment !== r.commitment || e.ts !== r.createdAt || d.program !== r.program || e.subject !== r.id) return false;
    return this.anchored ? this.audit().length === 0 : true;
  }
  audit(): string[] {
    const out: string[] = [];
    let prev = "0".repeat(64);
    const es = this.entries();
    es.forEach((e, i) => {
      if (e.seq !== i + 1) out.push(`sequence gap at ${e.seq}`);
      if (e.prev !== prev) out.push(`broken link at ${e.seq}`);
      if (HardenedDesign.hashOf(e) !== e.hash) out.push(`hash mismatch at ${e.seq}`);
      if (!verify(null, Buffer.from(e.hash, "hex"), this.operatorPublic, Buffer.from(e.sig, "base64"))) out.push(`bad signature at ${e.seq}`);
      prev = e.hash;
    });
    if (this.anchored) {
      const bySeq = new Map(es.map((e) => [e.seq, e.hash]));
      const bad = this.checkpoints.filter((c) => bySeq.get(c.count) !== c.head).length;
      if (bad) out.push(`${bad} witnessed checkpoint(s) no longer match the log`);
    }
    return out;
  }
  size() {
    return dbSize(this.db);
  }

  // ----------------------------------------------------------- insider (operator) powers
  /** Rewrite an entry's data and re-hash and re-sign it and every later entry (the operator holds the key). */
  consistentRewrite(seq: number, mutate: (e: { data: any; ts: number }) => void) {
    this.dropTriggers();
    const es = this.entries();
    let prev = seq === 1 ? "0".repeat(64) : es[seq - 2].hash;
    for (const e of es.filter((x) => x.seq >= seq)) {
      let data = e.data;
      let ts = e.ts;
      if (e.seq === seq) {
        const m = { data: JSON.parse(e.data), ts: e.ts };
        mutate(m);
        data = canonicalize(m.data);
        ts = m.ts;
      }
      const ne = { ...e, data, ts, prev };
      const hash = HardenedDesign.hashOf(ne);
      this.db.prepare("UPDATE entries SET data = ?, ts = ?, prev = ?, hash = ?, sig = ? WHERE seq = ?").run(data, ts, prev, hash, this.signHash(hash), e.seq);
      prev = hash;
    }
    this.addTriggers();
  }
  /** Remove an entry and renumber, re-link and re-sign everything after it. */
  consistentDelete(seq: number) {
    this.dropTriggers();
    const es = this.entries().filter((e) => e.seq !== seq);
    this.db.exec("DELETE FROM entries");
    let prev = "0".repeat(64);
    es.forEach((e, i) => {
      const ne = { ...e, seq: i + 1, prev };
      const hash = HardenedDesign.hashOf(ne);
      this.db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(ne.seq, e.kind, e.subject, e.actor, e.data, e.ts, prev, hash, this.signHash(hash));
      prev = hash;
    });
    this.addTriggers();
  }
  /** Append a correctly hashed and signed entry in someone else's name. */
  forge(kind: string, subject: number, actorClaimed: string, data: Record<string, unknown>) {
    return this.append(kind, subject, actorClaimed, data);
  }
  snapshot() {
    return { entries: this.entries(), checkpoints: [...this.checkpoints] };
  }
  restore(s: { entries: Entry[]; checkpoints: { count: number; head: string }[] }) {
    this.dropTriggers();
    this.db.exec("DELETE FROM entries");
    for (const e of s.entries) this.db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.seq, e.kind, e.subject, e.actor, e.data, e.ts, e.prev, e.hash, e.sig);
    this.addTriggers();
    this.checkpoints = s.checkpoints;
  }
}

export type CentralDesign = EditableDesign | HardenedDesign;
