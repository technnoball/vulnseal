// Tamper lab: simulates an insider who controls the off-chain database, the evidence
// store and the vault key, and runs real (expected-to-fail) on-chain attempts.
// Every change is backed up and can be restored. Demo mode only.
import fs from "node:fs";
import path from "node:path";
import { hexlify, randomBytes, ZeroHash } from "ethers";
import { reportRef } from "./domain.ts";
import { ServiceError, type VulnSealService } from "./service.ts";

export class TamperLab {
  private svc: VulnSealService;
  constructor(svc: VulnSealService) {
    this.svc = svc;
  }
  private get store() {
    return this.svc.store;
  }
  private get vault() {
    return this.svc.ctx.vault;
  }
  private backup(kind: string, target: string, json: unknown, data?: Uint8Array) {
    this.store.run("INSERT INTO lab_backups(kind, target, json, data, created_at) VALUES (?, ?, ?, ?, ?)", kind, target, JSON.stringify(json), data ?? null, new Date().toISOString());
  }

  /** Rewrite a stored reveal so it says something else (re-encrypted with the real key). */
  alterReveal(revealId: number) {
    const rv = this.store.get("SELECT * FROM reveals WHERE id = ?", revealId);
    if (!rv) throw new ServiceError("Reveal not found", 404);
    this.backup("reveal", String(revealId), null, rv.sealed);
    const pkg = this.vault.openJson<any>("reveal", `reveal:${revealId}`, rv.sealed);
    pkg.report.impact = `${pkg.report.impact} [rewritten after the fact by a database insider]`;
    this.store.run("UPDATE reveals SET sealed = ? WHERE id = ?", this.vault.sealJson("reveal", `reveal:${revealId}`, pkg), revealId);
    return { action: "alter-reveal", target: `reveal #${revealId}` };
  }

  /** Replace the stored commitment hash for a report (e.g. to match a different report). */
  alterCommitment(cid: number) {
    const r = this.store.get("SELECT commitment FROM reports WHERE cid = ?", cid);
    if (!r) throw new ServiceError("Report not found", 404);
    this.backup("commitment", String(cid), { commitment: r.commitment });
    this.store.run("UPDATE reports SET commitment = ? WHERE cid = ?", hexlify(randomBytes(32)), cid);
    return { action: "alter-commitment", target: reportRef(cid) };
  }

  /** Delete an event (e.g. an unfavourable status change) from the off-chain history. */
  deleteEvent(seq: number) {
    const e = this.store.get("SELECT * FROM chain_events WHERE seq = ?", seq);
    if (!e) throw new ServiceError("Event not found in the off-chain history", 404);
    this.backup("event", String(seq), e);
    this.store.run("DELETE FROM chain_events WHERE seq = ?", seq);
    return { action: "delete-event", target: `log #${seq}` };
  }

  alterEvidence(id: string) {
    const e = this.store.get("SELECT * FROM evidence WHERE id = ?", id);
    if (!e) throw new ServiceError("Evidence not found", 404);
    const p = path.join(this.svc.ctx.evidenceDir, e.stored_name);
    const sealed = fs.readFileSync(p);
    this.backup("evidence", id, { stored: e.stored_name }, sealed);
    const plain = this.vault.open("evidence", `evidence:${id}`, sealed);
    fs.writeFileSync(p, this.vault.seal("evidence", `evidence:${id}`, Buffer.concat([plain, Buffer.from("\n[altered]")])));
    return { action: "alter-evidence", target: id };
  }

  alterRationale(aid: number) {
    const a = this.store.get("SELECT * FROM associations WHERE aid = ?", aid);
    if (!a) throw new ServiceError("Association not found", 404);
    this.backup("rationale", String(aid), null, a.sealed);
    const text = this.vault.open("rationale", `assoc:${aid}`, a.sealed).toString("utf8");
    this.store.run("UPDATE associations SET sealed = ? WHERE aid = ?", this.vault.seal("rationale", `assoc:${aid}`, Buffer.from(`${text} (edited to support a different outcome)`)), aid);
    return { action: "alter-rationale", target: `association #${aid}` };
  }

  restoreAll() {
    const rows = this.store.all("SELECT * FROM lab_backups ORDER BY id DESC");
    for (const b of rows) {
      const json = JSON.parse(b.json);
      if (b.kind === "reveal") this.store.run("UPDATE reveals SET sealed = ? WHERE id = ?", b.data, Number(b.target));
      else if (b.kind === "commitment") this.store.run("UPDATE reports SET commitment = ? WHERE cid = ?", json.commitment, Number(b.target));
      else if (b.kind === "event")
        this.store.run(
          "INSERT OR REPLACE INTO chain_events(seq, kind, subject, actor, data_hash, entry_hash, timestamp, tx_hash, block_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          json.seq, json.kind, json.subject, json.actor, json.data_hash, json.entry_hash, json.timestamp, json.tx_hash, json.block_number,
        );
      else if (b.kind === "evidence") fs.writeFileSync(path.join(this.svc.ctx.evidenceDir, json.stored), b.data);
      else if (b.kind === "rationale") this.store.run("UPDATE associations SET sealed = ? WHERE aid = ?", b.data, Number(b.target));
    }
    this.store.run("DELETE FROM lab_backups");
    return { restored: rows.length };
  }

  state() {
    return this.store.all("SELECT id, kind, target, created_at FROM lab_backups ORDER BY id");
  }

  /** Real transactions that try to rewrite history; every one should be rejected. */
  async chainAttempts(cid: number) {
    const r = this.store.get("SELECT * FROM reports WHERE cid = ?", cid);
    if (!r) throw new ServiceError("Report not found", 404);
    const c = await this.svc.commitmentOnChain(cid);
    const other = ["basalt", "quillfox", "nightjar"].find((x) => x !== r.researcher_id)!;
    const attempts: { attempt: string; rejected: boolean; error: string | null; contractError: string | null }[] = [];
    const run = async (attempt: string, who: string, fn: string, args: unknown[]) => {
      try {
        await this.svc.ledger.send(who, fn, args);
        attempts.push({ attempt, rejected: false, error: null, contractError: null });
      } catch (e: any) {
        attempts.push({ attempt, rejected: true, error: e.message, contractError: e.contractError?.name ?? null });
      }
    };
    await run(`Re-anchor the same commitment again as its owner (replay)`, r.researcher_id, "anchorCommitment", [c.commitment, c.programId, c.policyVersion]);
    await run(`Another researcher "revises" ${reportRef(cid)} to replace it`, other, "reviseCommitment", [cid, hexlify(randomBytes(32)), c.policyVersion]);
    await run(`Program admin of a different program changes its triage status`, r.program_id === 2 ? "ashgrove-admin" : "kestrel-admin", "setTriage", [cid, 8, ZeroHash]);
    await run(`Researcher records their own reveal as verified`, r.researcher_id, "recordReveal", [cid, 1, hexlify(randomBytes(32))]);
    const after = await this.svc.commitmentOnChain(cid);
    const mutating: string[] = [];
    this.svc.ledger.contract.interface.forEachFunction((f) => {
      if (f.stateMutability !== "view" && f.stateMutability !== "pure") mutating.push(f.name);
    });
    return { attempts, unchanged: after.commitment === c.commitment && after.anchoredAt === c.anchoredAt && after.status === c.status, mutatingFunctions: mutating };
  }
}
