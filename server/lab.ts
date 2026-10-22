// Tamper lab: deliberately simulates an insider who controls the off-chain
// database or file store, and runs real (expected-to-fail) on-chain attacks.
// Every modification is backed up so it can be restored. Demo-mode only.
import fs from "node:fs";
import { canonicalize, payloadDigest, sha256Hex } from "./canonical.ts";
import { typeCode } from "./domain.ts";
import { LedgerError } from "./chain.ts";
import { NO_REF } from "./ledger-hash.ts";
import { PatchLedgerService, ServiceError } from "./service.ts";
import type { EventRow } from "./db.ts";

export class TamperLab {
  private svc: PatchLedgerService;
  constructor(svc: PatchLedgerService) {
    this.svc = svc;
  }

  private backup(kind: string, target: string, json?: unknown, data?: Uint8Array) {
    this.svc.store.db
      .prepare("INSERT INTO lab_backups(kind, target, data, json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(kind, target, data ?? null, json === undefined ? null : JSON.stringify(json), new Date().toISOString());
  }

  private row(publicId: string, seq: number): EventRow {
    const r = this.svc.store.db.prepare("SELECT * FROM events WHERE public_id = ? AND seq = ?").get(publicId, seq) as EventRow | undefined;
    if (!r) throw new ServiceError(`Record #${seq} not found in the database for ${publicId}`, 404);
    return r;
  }

  /** Rewrite a stored payload (and its digest column) as a database insider would. */
  editRecord(publicId: string, seq: number) {
    const r = this.row(publicId, seq);
    this.backup("event", `${publicId}#${seq}`, r);
    const p = JSON.parse(r.payload);
    if (Array.isArray(p.componentAssertions) && p.componentAssertions.length) {
      p.componentAssertions = p.componentAssertions.map((a: any) => ({ ...a, state: a.state === "replaced" ? "original" : "replaced" }));
    }
    p.description = `${p.description ?? ""} [silently edited by database insider]`.trim();
    if (p.result) p.result = p.result === "pass" ? "fail" : "pass";
    const canonical = canonicalize(p);
    this.svc.store.db.prepare("UPDATE events SET payload = ?, payload_digest = ? WHERE public_id = ? AND seq = ?").run(canonical, payloadDigest(canonical), publicId, seq);
    return { action: "edit-record", publicId, seq, note: "Payload and digest column rewritten directly in SQLite (application bypassed)." };
  }

  deleteRecord(publicId: string, seq: number) {
    const r = this.row(publicId, seq);
    this.backup("event", `${publicId}#${seq}`, r);
    this.svc.store.db.prepare("DELETE FROM events WHERE public_id = ? AND seq = ?").run(publicId, seq);
    return { action: "delete-record", publicId, seq, note: "Row deleted directly from SQLite (application bypassed)." };
  }

  /** mode "file": alter bytes only; "file-and-db": alter bytes and update the stored digest to match. */
  alterEvidence(evidenceId: string, mode: "file" | "file-and-db" = "file") {
    const e = this.svc.store.getEvidence(evidenceId);
    if (!e) throw new ServiceError(`Evidence ${evidenceId} not found`, 404);
    const p = this.svc.vault.pathOf(e.stored_name);
    if (!fs.existsSync(p)) throw new ServiceError("Evidence file already missing", 409);
    const original = fs.readFileSync(p);
    this.backup("evidence-file", evidenceId, { sha256: e.sha256 }, original);
    const altered = Buffer.concat([original, Buffer.from("\n<!-- altered after submission -->\n")]);
    fs.writeFileSync(p, altered);
    if (mode === "file-and-db") this.svc.store.db.prepare("UPDATE evidence SET sha256 = ? WHERE id = ?").run(sha256Hex(altered), evidenceId);
    return { action: "alter-evidence", evidenceId, mode, note: mode === "file" ? "File bytes changed on disk." : "File bytes changed and database digest updated to match." };
  }

  restoreAll() {
    const rows = this.svc.store.db.prepare("SELECT * FROM lab_backups ORDER BY id DESC").all() as any[];
    for (const b of rows) {
      if (b.kind === "event") {
        const r = JSON.parse(b.json) as EventRow;
        this.svc.store.db.prepare("DELETE FROM events WHERE public_id = ? AND seq = ?").run(r.public_id, r.seq);
        this.svc.store.insertEvent(r);
      } else if (b.kind === "evidence-file") {
        const e = this.svc.store.getEvidence(b.target);
        if (e) {
          fs.writeFileSync(this.svc.vault.pathOf(e.stored_name), b.data as Uint8Array);
          this.svc.store.db.prepare("UPDATE evidence SET sha256 = ? WHERE id = ?").run(JSON.parse(b.json).sha256, b.target);
        }
      }
    }
    this.svc.store.db.prepare("DELETE FROM lab_backups").run();
    return { restored: rows.length };
  }

  state() {
    return (this.svc.store.db.prepare("SELECT id, kind, target, created_at FROM lab_backups ORDER BY id").all() as any[]).map((r) => ({ ...r }));
  }

  /** Real on-chain attempts to rewrite or remove history. All are expected to revert. */
  async chainAttempts(actorId: string, publicId: string, seq: number) {
    const device = this.svc.store.getDevice(publicId);
    if (!device) throw new ServiceError(`Device ${publicId} not found`, 404);
    const recs = await this.svc.ledger.getRecords(device.device_key);
    const target = recs[seq];
    if (!target) throw new ServiceError(`Record #${seq} not on-chain`, 404);
    const forged = payloadDigest(canonicalize({ forged: true, replaces: seq, at: Date.now() }));
    const attempts: { attempt: string; rejected: boolean; error: string | null; contractError?: string }[] = [];
    const run = async (attempt: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        attempts.push({ attempt, rejected: false, error: null });
      } catch (e) {
        const le = e as LedgerError;
        attempts.push({ attempt, rejected: true, error: le.message, contractError: le.contractError?.name });
      }
    };
    await run(`Append a replacement for record #${seq} by building on its predecessor (prevHash ${target.prevHash.slice(0, 10)}…)`, () =>
      this.svc.ledger.appendRecord(actorId, {
        deviceKey: device.device_key,
        recordType: typeCode("REPAIR"),
        expectedPrevHash: target.prevHash,
        payloadDigest: forged,
        refSeq: NO_REF,
      }),
    );
    await run("Re-register the device to overwrite its registration record", () => this.svc.ledger.registerDevice(actorId, device.device_key, forged));
    await run(`Call a non-existent updateRecord(${seq}) function`, async () => {
      const data = "0x" + Buffer.from("updateRecord").toString("hex").slice(0, 8);
      await this.svc.ledger.rawWrite(actorId, async (c) => {
        const runner = c.runner as any;
        return runner.sendTransaction({ to: await c.getAddress(), data });
      });
    });
    const after = await this.svc.ledger.getRecords(device.device_key);
    return {
      actor: actorId,
      attempts,
      mutatingFunctions: this.svc.ledger.mutatingFunctions(),
      recordUnchanged: after[seq]?.recordHash === target.recordHash,
      recordCountBefore: recs.length,
      recordCountAfter: after.length,
    };
  }
}
