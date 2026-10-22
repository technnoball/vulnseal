// Off-chain store (SQLite via Node's built-in node:sqlite).
// Holds detailed payloads and evidence metadata; the chain holds commitments.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DeviceRow {
  public_id: string;
  device_key: string;
  brand: string;
  model: string;
  year: number | null;
  form_factor: string;
  synthetic: number;
  created_at: string;
}

export interface EventRow {
  public_id: string;
  seq: number;
  type: string;
  payload: string; // canonical JSON
  payload_digest: string;
  record_hash: string;
  prev_hash: string;
  actor_address: string;
  actor_id: string;
  ref_seq: number | null;
  outcome: number;
  chain_ts: number;
  tx_hash: string;
  block_number: number;
  gas_used: number;
  created_at: string;
}

export interface EvidenceRow {
  id: string;
  public_id: string;
  filename: string;
  stored_name: string;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  description: string;
  uploaded_by: string;
  access: "restricted" | "shareable";
  linked_seq: number | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  public_id TEXT PRIMARY KEY,
  device_key TEXT NOT NULL UNIQUE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  form_factor TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  public_id TEXT NOT NULL REFERENCES devices(public_id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  actor_address TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  ref_seq INTEGER,
  outcome INTEGER NOT NULL DEFAULT 0,
  chain_ts INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  gas_used INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (public_id, seq)
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL REFERENCES devices(public_id),
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'restricted',
  linked_seq INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_sha ON evidence(sha256);
CREATE TABLE IF NOT EXISTS lab_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  data BLOB,
  json TEXT,
  created_at TEXT NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.path = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  insertDevice(d: DeviceRow) {
    this.db
      .prepare(
        `INSERT INTO devices (public_id, device_key, brand, model, year, form_factor, synthetic, created_at)
         VALUES (:public_id, :device_key, :brand, :model, :year, :form_factor, :synthetic, :created_at)`,
      )
      .run({ ...d });
  }
  getDevice(publicId: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE public_id = ?").get(publicId) as DeviceRow | undefined;
  }
  listDevices(): DeviceRow[] {
    return this.db.prepare("SELECT * FROM devices ORDER BY created_at, public_id").all() as unknown as DeviceRow[];
  }

  insertEvent(e: EventRow) {
    this.db
      .prepare(
        `INSERT INTO events (public_id, seq, type, payload, payload_digest, record_hash, prev_hash, actor_address, actor_id,
           ref_seq, outcome, chain_ts, tx_hash, block_number, gas_used, created_at)
         VALUES (:public_id, :seq, :type, :payload, :payload_digest, :record_hash, :prev_hash, :actor_address, :actor_id,
           :ref_seq, :outcome, :chain_ts, :tx_hash, :block_number, :gas_used, :created_at)`,
      )
      .run({ ...e });
  }
  listEvents(publicId: string): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE public_id = ? ORDER BY seq").all(publicId) as unknown as EventRow[];
  }
  recentEvents(limit: number): EventRow[] {
    return this.db.prepare("SELECT * FROM events ORDER BY chain_ts DESC, block_number DESC LIMIT ?").all(limit) as unknown as EventRow[];
  }
  allEvents(): EventRow[] {
    return this.db.prepare("SELECT * FROM events ORDER BY public_id, seq").all() as unknown as EventRow[];
  }

  insertEvidence(e: EvidenceRow) {
    this.db
      .prepare(
        `INSERT INTO evidence (id, public_id, filename, stored_name, mime, size, sha256, kind, description, uploaded_by, access, linked_seq, created_at)
         VALUES (:id, :public_id, :filename, :stored_name, :mime, :size, :sha256, :kind, :description, :uploaded_by, :access, :linked_seq, :created_at)`,
      )
      .run({ ...e });
  }
  getEvidence(id: string): EvidenceRow | undefined {
    return this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
  }
  evidenceBySha(sha: string): EvidenceRow[] {
    return this.db.prepare("SELECT * FROM evidence WHERE sha256 = ? ORDER BY created_at").all(sha) as unknown as EvidenceRow[];
  }
  evidenceForDevice(publicId: string): EvidenceRow[] {
    return this.db.prepare("SELECT * FROM evidence WHERE public_id = ? ORDER BY created_at").all(publicId) as unknown as EvidenceRow[];
  }
  linkEvidence(ids: string[], seq: number) {
    const st = this.db.prepare("UPDATE evidence SET linked_seq = ? WHERE id = ? AND linked_seq IS NULL");
    for (const id of ids) st.run(seq, id);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
