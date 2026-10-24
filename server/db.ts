// Off-chain store. Confidential material is only ever written as Vault ciphertext
// (columns named `sealed*`); everything else here is either public on-chain anyway
// or a mirror of chain state kept for fast reads and integrity checks.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, short TEXT NOT NULL,
  blurb TEXT NOT NULL, name_tag TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  program_id INTEGER NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL,
  published_at TEXT NOT NULL, PRIMARY KEY (program_id, version)
);

CREATE TABLE IF NOT EXISTS reports (
  cid INTEGER PRIMARY KEY,
  researcher_id TEXT NOT NULL,
  researcher_address TEXT NOT NULL,
  program_id INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  commitment TEXT NOT NULL,
  supersedes INTEGER,
  superseded_by INTEGER,
  status INTEGER NOT NULL,
  mismatches INTEGER NOT NULL DEFAULT 0,
  reveal_digest TEXT,
  anchored_at INTEGER NOT NULL,
  log_seq INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  gas_used INTEGER NOT NULL,
  sealed BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, cid INTEGER, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  mime TEXT NOT NULL, sealed_name BLOB NOT NULL, stored_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_cid ON evidence(cid);

CREATE TABLE IF NOT EXISTS reveals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cid INTEGER NOT NULL,
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  source TEXT NOT NULL,
  precheck TEXT NOT NULL,
  sealed BLOB NOT NULL,
  verified_by TEXT,
  verified_at TEXT,
  outcome TEXT,
  reveal_digest TEXT,
  tx_hash TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cid INTEGER NOT NULL, program_id INTEGER NOT NULL,
  author_id TEXT NOT NULL, sealed BLOB NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  cid INTEGER NOT NULL, to_program INTEGER NOT NULL, granted_by TEXT NOT NULL, tx_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (cid, to_program)
);

CREATE TABLE IF NOT EXISTS associations (
  aid INTEGER PRIMARY KEY, cid_a INTEGER NOT NULL, cid_b INTEGER NOT NULL, relation INTEGER NOT NULL,
  status INTEGER NOT NULL, proposer_id TEXT NOT NULL, family TEXT, salt TEXT NOT NULL, digest TEXT NOT NULL,
  sealed BLOB NOT NULL, tx_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS association_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, aid INTEGER NOT NULL, reviewer_id TEXT NOT NULL, approve INTEGER NOT NULL,
  salt TEXT NOT NULL, digest TEXT NOT NULL, sealed BLOB NOT NULL, tx_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  did INTEGER PRIMARY KEY, kind INTEGER NOT NULL, subject INTEGER NOT NULL, cid_a INTEGER NOT NULL, cid_b INTEGER,
  opener_id TEXT NOT NULL, status INTEGER NOT NULL, round INTEGER NOT NULL, decision INTEGER, reason_code INTEGER,
  first_decision INTEGER, first_reason INTEGER, reversed INTEGER NOT NULL DEFAULT 0, policy_digest TEXT NOT NULL,
  salt TEXT NOT NULL, digest TEXT NOT NULL, sealed BLOB NOT NULL, opened_at INTEGER NOT NULL, decided_at INTEGER,
  tx_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dispute_acts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, did INTEGER NOT NULL, act TEXT NOT NULL, round INTEGER NOT NULL,
  actor_id TEXT NOT NULL, decision INTEGER, reason_code INTEGER, salt TEXT, digest TEXT, sealed BLOB,
  tx_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_events (
  seq INTEGER PRIMARY KEY, kind INTEGER NOT NULL, subject TEXT NOT NULL, actor TEXT NOT NULL,
  data_hash TEXT NOT NULL, entry_hash TEXT NOT NULL, timestamp INTEGER NOT NULL, tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, identity_id TEXT NOT NULL, action TEXT NOT NULL,
  object TEXT NOT NULL, allowed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_private (
  identity_id TEXT PRIMARY KEY, sealed BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target TEXT NOT NULL, json TEXT, data BLOB,
  created_at TEXT NOT NULL
);
`;

export type Row = Record<string, any>;

export class Store {
  readonly db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }
  close() {
    this.db.close();
  }
  get(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }
  getMeta(key: string): string | undefined {
    return this.get("SELECT value FROM meta WHERE key = ?", key)?.value;
  }
  setMeta(key: string, value: string) {
    this.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  tx<T>(fn: () => T): T {
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
