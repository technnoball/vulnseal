// Centralised baselines for the comparative benchmark.
//
// EditableStore  — a conventional CRUD SQLite store: application-level role
//                  checks, evidence digests in a column, corrections and
//                  dispute status updated in place.
// HardenedStore  — append-only application semantics: UPDATE/DELETE blocked by
//                  triggers, SHA-256 hash chain per device, application-level
//                  role checks, optional head-hash checkpoints handed to an
//                  independent party after every write ("anchored").
//
// Both use the same role rules as the smart contract, so differences come from
// where the rules are enforced, not from weaker logic.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize, sha256Hex } from "../../server/canonical.ts";
import { IDENTITIES, type RecordType, type RoleName } from "../../server/domain.ts";

export interface Finding {
  severity: "error" | "warning";
  code: string;
  seq?: number;
}

const ROLES = new Map(IDENTITIES.map((i) => [i.id, i.roles]));
const has = (actor: string, ...r: RoleName[]) => (ROLES.get(actor) ?? []).some((x) => r.includes(x));
const isClaim = (t: string) => t !== "CHALLENGE" && t !== "RESOLUTION";

/** Same authorisation rules as PatchLedger.sol, evaluated in application code. */
export function authorize(
  actor: string,
  type: RecordType,
  target?: { actor: string; type: string },
  challenge?: { actor: string; targetActor: string },
): string | null {
  switch (type) {
    case "REGISTRATION":
      return has(actor, "REGISTRAR") ? null : "NotAuthorized";
    case "DIAGNOSTIC":
    case "REPAIR":
    case "COMPONENT_REPLACEMENT":
      return has(actor, "REPAIRER", "INSPECTOR") ? null : "NotAuthorized";
    case "INSPECTION":
      return has(actor, "INSPECTOR") ? null : "NotAuthorized";
    case "CUSTODY_TRANSFER":
      return has(actor, "REGISTRAR", "INSPECTOR") ? null : "NotAuthorized";
    case "EVIDENCE_ATTACHMENT":
    case "CORRECTION":
      if (!target || !isClaim(target.type)) return "InvalidReference";
      if (has(actor, "AUDITOR")) return null;
      if (!has(actor, "REGISTRAR", "REPAIRER", "INSPECTOR")) return "NotAuthorized";
      return target.actor === actor ? null : "NotOriginalActor";
    case "CORROBORATION":
      if (!has(actor, "INSPECTOR", "AUDITOR")) return "NotAuthorized";
      if (!target || !isClaim(target.type)) return "InvalidReference";
      return target.actor === actor ? "SelfCorroboration" : null;
    case "CHALLENGE":
      if (!has(actor, "VERIFIER", "INSPECTOR", "REPAIRER")) return "NotAuthorized";
      if (!target || !isClaim(target.type)) return "InvalidReference";
      return target.actor === actor ? "SelfChallenge" : null;
    case "RESOLUTION":
      if (!has(actor, "AUDITOR")) return "NotAuthorized";
      if (!challenge) return "InvalidReference";
      if (challenge.targetActor === actor) return "SelfResolution";
      return challenge.actor === actor ? "ConflictOfInterest" : null;
  }
  return "InvalidRecordType";
}

export class Unauthorized extends Error {}

/** Component-lineage conflicts: same rule as the PatchLedger service. */
export function lineageConflicts(records: { seq: number; type: string; payload: any; inactive: boolean }[]): number {
  const replaced = new Map<string, number>();
  let n = 0;
  for (const r of records) {
    if (!isClaim(r.type) || r.inactive) continue;
    for (const a of (r.payload.componentAssertions ?? []) as { component: string; state: string }[]) {
      if (a.state === "replaced" && !replaced.has(a.component)) replaced.set(a.component, r.seq);
      if (a.state === "original" && replaced.has(a.component)) n++;
    }
  }
  return n;
}

function dbSize(db: DatabaseSync): number {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const pc = (db.prepare("PRAGMA page_count").get() as any).page_count as number;
  const ps = (db.prepare("PRAGMA page_size").get() as any).page_size as number;
  return pc * ps;
}

// ---------------------------------------------------------------------------
export class EditableStore {
  readonly db: DatabaseSync;
  readonly evDir: string;
  constructor(dir: string) {
    fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
    this.evDir = path.join(dir, "evidence");
    this.db = new DatabaseSync(path.join(dir, "editable.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE records (device TEXT, seq INTEGER, type TEXT, actor TEXT, payload TEXT, evidence_id TEXT, evidence_sha TEXT,
        ref_seq INTEGER, updated_at TEXT, PRIMARY KEY (device, seq));
      CREATE TABLE disputes (id INTEGER PRIMARY KEY, device TEXT, target_seq INTEGER, challenger TEXT, reason TEXT, status TEXT, resolver TEXT, outcome TEXT);
      CREATE INDEX ed_sha ON records(evidence_sha);`);
  }
  storeEvidence(id: string, data: Uint8Array): string {
    fs.writeFileSync(path.join(this.evDir, id), data);
    return sha256Hex(data);
  }
  get(device: string, seq: number): any {
    return this.db.prepare("SELECT * FROM records WHERE device=? AND seq=?").get(device, seq);
  }
  rows(device: string): any[] {
    return this.db.prepare("SELECT * FROM records WHERE device=? ORDER BY seq").all(device) as any[];
  }
  /** Application write path. Returns the affected seq. */
  append(actor: string, device: string, type: RecordType, payload: any, refSeq?: number, evidence?: { id: string; sha: string }): number {
    const target = refSeq !== undefined ? this.get(device, refSeq) : undefined;
    if (type === "RESOLUTION") {
      const d = this.db.prepare("SELECT * FROM disputes WHERE id=?").get(refSeq!) as any;
      const t = d ? this.get(d.device, d.target_seq) : undefined;
      const err = authorize(actor, type, undefined, d && t ? { actor: d.challenger, targetActor: t.actor } : undefined);
      if (err) throw new Unauthorized(err);
      this.db.prepare("UPDATE disputes SET status='resolved', resolver=?, outcome=? WHERE id=?").run(actor, payload.outcome ?? "", refSeq!);
      return refSeq!;
    }
    const err = authorize(actor, type, target ? { actor: target.actor, type: target.type } : undefined);
    if (err) throw new Unauthorized(err);
    if (type === "CORRECTION") {
      // conventional CRUD: overwrite the claim in place
      const merged = { ...JSON.parse(target.payload), ...(payload.corrected ?? {}) };
      this.db.prepare("UPDATE records SET payload=?, updated_at=? WHERE device=? AND seq=?").run(JSON.stringify(merged), new Date().toISOString(), device, refSeq!);
      return refSeq!;
    }
    if (type === "CHALLENGE") {
      const r = this.db.prepare("INSERT INTO disputes(device, target_seq, challenger, reason, status) VALUES (?,?,?,?, 'open')").run(device, refSeq!, actor, payload.reason ?? "");
      return Number(r.lastInsertRowid);
    }
    const seq = ((this.db.prepare("SELECT MAX(seq) m FROM records WHERE device=?").get(device) as any).m ?? -1) + 1;
    this.db
      .prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?)")
      .run(device, seq, type, actor, JSON.stringify(payload), evidence?.id ?? null, evidence?.sha ?? null, refSeq ?? null, new Date().toISOString());
    return seq;
  }
  /** Best-effort verification available to a conventional store. */
  verify(device: string): Finding[] {
    const out: Finding[] = [];
    const rows = this.rows(device);
    rows.forEach((r, i) => {
      if (r.seq !== i) out.push({ severity: "error", code: "SEQUENCE_GAP", seq: r.seq });
      if (r.evidence_id) {
        const p = path.join(this.evDir, r.evidence_id);
        if (!fs.existsSync(p) || sha256Hex(fs.readFileSync(p)) !== r.evidence_sha) out.push({ severity: "error", code: "EVIDENCE_MISMATCH", seq: r.seq });
      }
    });
    return out;
  }
  openDisputes(device: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM disputes WHERE device=? AND status='open'").get(device) as any).c;
  }
  conflicts(device: string): number {
    return lineageConflicts(this.rows(device).map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload), inactive: false })));
  }
  reuseCount(sha: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM records WHERE evidence_sha=?").get(sha) as any).c;
  }
  sizeBytes() {
    return dbSize(this.db);
  }
}

// ---------------------------------------------------------------------------
const ZERO = "0".repeat(64);

export class HardenedStore {
  readonly db: DatabaseSync;
  readonly evDir: string;
  readonly anchored: boolean;
  /** Head hashes handed to an independent party; the insider cannot change these. */
  readonly checkpoints = new Map<string, { count: number; head: string }>();
  private checkpointFile: string;

  constructor(dir: string, anchored: boolean) {
    this.anchored = anchored;
    const name = anchored ? "hardened-anchored" : "hardened";
    fs.mkdirSync(path.join(dir, name + "-evidence"), { recursive: true });
    this.evDir = path.join(dir, name + "-evidence");
    this.checkpointFile = path.join(dir, name + "-checkpoints.json");
    this.db = new DatabaseSync(path.join(dir, name + ".sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE records (device TEXT, seq INTEGER, type TEXT, actor TEXT, payload TEXT, payload_digest TEXT, prev_hash TEXT,
        record_hash TEXT, ref_seq INTEGER, created_at TEXT, PRIMARY KEY (device, seq));
      CREATE TABLE evidence_index (sha TEXT, device TEXT, seq INTEGER);
      CREATE INDEX hd_sha ON evidence_index(sha);`);
    this.addTriggers();
  }
  addTriggers() {
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'append-only'); END;`);
  }
  dropTriggers() {
    this.db.exec("DROP TRIGGER IF EXISTS no_update; DROP TRIGGER IF EXISTS no_delete;");
  }
  storeEvidence(id: string, data: Uint8Array): string {
    fs.writeFileSync(path.join(this.evDir, id), data);
    return sha256Hex(data);
  }
  static hash(r: { device: string; seq: number; type: string; actor: string; payload_digest: string; prev_hash: string; ref_seq: number | null }) {
    return sha256Hex(canonicalize({ device: r.device, seq: r.seq, type: r.type, actor: r.actor, payloadDigest: r.payload_digest, prevHash: r.prev_hash, refSeq: r.ref_seq }));
  }
  get(device: string, seq: number): any {
    return this.db.prepare("SELECT * FROM records WHERE device=? AND seq=?").get(device, seq);
  }
  rows(device: string): any[] {
    return this.db.prepare("SELECT * FROM records WHERE device=? ORDER BY seq").all(device) as any[];
  }
  private insertRaw(actor: string, device: string, type: string, payload: any, refSeq: number | null): number {
    const last = this.db.prepare("SELECT seq, record_hash FROM records WHERE device=? ORDER BY seq DESC LIMIT 1").get(device) as any;
    const seq = last ? last.seq + 1 : 0;
    const canonical = canonicalize(payload);
    const row = { device, seq, type, actor, payload: canonical, payload_digest: sha256Hex(canonical), prev_hash: last ? last.record_hash : ZERO, ref_seq: refSeq };
    const record_hash = HardenedStore.hash(row);
    this.db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?)").run(device, seq, type, actor, canonical, row.payload_digest, row.prev_hash, record_hash, refSeq, new Date().toISOString());
    for (const e of (payload.evidence ?? []) as { sha256: string }[]) this.db.prepare("INSERT INTO evidence_index VALUES (?,?,?)").run(e.sha256, device, seq);
    return seq;
  }
  /** Application write path. */
  append(actor: string, device: string, type: RecordType, payload: any, refSeq?: number): number {
    const target = refSeq !== undefined ? this.get(device, refSeq) : undefined;
    let challenge: { actor: string; targetActor: string } | undefined;
    if (type === "RESOLUTION" && target?.type === "CHALLENGE") challenge = { actor: target.actor, targetActor: this.get(device, target.ref_seq)?.actor };
    const err = authorize(actor, type, target ? { actor: target.actor, type: target.type } : undefined, challenge);
    if (err) throw new Unauthorized(err);
    const seq = this.insertRaw(actor, device, type, payload, refSeq ?? null);
    if (this.anchored) this.publishCheckpoint(device);
    return seq;
  }
  private publishCheckpoint(device: string) {
    const last = this.db.prepare("SELECT seq, record_hash FROM records WHERE device=? ORDER BY seq DESC LIMIT 1").get(device) as any;
    this.checkpoints.set(device, { count: last.seq + 1, head: last.record_hash });
    // the copy handed to the independent party (written for realism of the cost)
    fs.writeFileSync(this.checkpointFile, JSON.stringify(Object.fromEntries(this.checkpoints)));
  }
  verify(device: string): Finding[] {
    const out: Finding[] = [];
    const rows = this.rows(device);
    let prev = ZERO;
    rows.forEach((r, i) => {
      if (r.seq !== i) out.push({ severity: "error", code: "SEQUENCE_GAP", seq: r.seq });
      if (sha256Hex(r.payload) !== r.payload_digest) out.push({ severity: "error", code: "PAYLOAD_DIGEST", seq: r.seq });
      if (r.prev_hash !== prev) out.push({ severity: "error", code: "LINK_BROKEN", seq: r.seq });
      if (HardenedStore.hash(r) !== r.record_hash) out.push({ severity: "error", code: "HASH_MISMATCH", seq: r.seq });
      for (const e of (JSON.parse(r.payload).evidence ?? []) as { id: string; sha256: string }[]) {
        const p = path.join(this.evDir, e.id);
        if (!fs.existsSync(p) || sha256Hex(fs.readFileSync(p)) !== e.sha256) out.push({ severity: "error", code: "EVIDENCE_MISMATCH", seq: r.seq });
      }
      prev = r.record_hash;
    });
    if (this.anchored) {
      const cp = this.checkpoints.get(device);
      if (cp) {
        const atCp = rows.find((r) => r.seq === cp.count - 1);
        if (rows.length < cp.count || !atCp || atCp.record_hash !== cp.head) out.push({ severity: "error", code: "CHECKPOINT_MISMATCH" });
      }
    }
    return out;
  }
  // --- insider capabilities (DB administrator) -----------------------------
  editOwnHash(device: string, seq: number, mutate: (p: any) => void) {
    this.dropTriggers();
    const r = this.get(device, seq);
    const p = JSON.parse(r.payload);
    mutate(p);
    const canonical = canonicalize(p);
    const nr = { ...r, payload: canonical, payload_digest: sha256Hex(canonical) };
    this.db.prepare("UPDATE records SET payload=?, payload_digest=?, record_hash=? WHERE device=? AND seq=?").run(canonical, nr.payload_digest, HardenedStore.hash(nr), device, seq);
    this.addTriggers();
  }
  editPayloadOnly(device: string, seq: number, mutate: (p: any) => void) {
    this.dropTriggers();
    const r = this.get(device, seq);
    const p = JSON.parse(r.payload);
    mutate(p);
    this.db.prepare("UPDATE records SET payload=? WHERE device=? AND seq=?").run(canonicalize(p), device, seq);
    this.addTriggers();
  }
  consistentRewrite(device: string, seq: number, mutate: (p: any) => void) {
    this.dropTriggers();
    const rows = this.rows(device);
    let prev = seq === 0 ? ZERO : rows[seq - 1].record_hash;
    for (const r of rows.filter((x) => x.seq >= seq)) {
      let payload = r.payload;
      if (r.seq === seq) {
        const p = JSON.parse(payload);
        mutate(p);
        payload = canonicalize(p);
      }
      const nr = { ...r, payload, payload_digest: sha256Hex(payload), prev_hash: prev };
      const h = HardenedStore.hash(nr);
      this.db.prepare("UPDATE records SET payload=?, payload_digest=?, prev_hash=?, record_hash=? WHERE device=? AND seq=?").run(payload, nr.payload_digest, prev, h, device, r.seq);
      prev = h;
    }
    this.addTriggers();
  }
  deleteRecord(device: string, seq: number) {
    this.dropTriggers();
    this.db.prepare("DELETE FROM records WHERE device=? AND seq=?").run(device, seq);
    this.addTriggers();
  }
  /** Insider appends a correctly-hashed record in someone else's name (no signatures to stop it). */
  forgeAppend(actorClaimed: string, device: string, type: string, payload: any, refSeq: number | null): number {
    return this.insertRaw(actorClaimed, device, type, payload, refSeq);
  }
  snapshot(device: string): any[] {
    return this.rows(device);
  }
  restore(device: string, rows: any[]) {
    this.dropTriggers();
    this.db.prepare("DELETE FROM records WHERE device=?").run(device);
    const st = this.db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const r of rows) st.run(r.device, r.seq, r.type, r.actor, r.payload, r.payload_digest, r.prev_hash, r.record_hash, r.ref_seq, r.created_at);
    this.addTriggers();
  }
  openDisputes(device: string): number {
    const rows = this.rows(device);
    const resolved = new Set(rows.filter((r) => r.type === "RESOLUTION").map((r) => r.ref_seq));
    return rows.filter((r) => r.type === "CHALLENGE" && !resolved.has(r.seq)).length;
  }
  conflicts(device: string): number {
    const rows = this.rows(device);
    const superseded = new Set(rows.filter((r) => r.type === "CORRECTION").map((r) => r.ref_seq));
    return lineageConflicts(rows.map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload), inactive: superseded.has(r.seq) })));
  }
  reuseCount(sha: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM evidence_index WHERE sha=?").get(sha) as any).c;
  }
  sizeBytes() {
    return dbSize(this.db);
  }
}
