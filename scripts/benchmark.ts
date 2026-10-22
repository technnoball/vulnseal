// Comparative benchmark: editable SQLite vs hardened (append-only, hash-chained)
// SQLite (with and without external checkpoints) vs the real PatchLedger
// contract on a dedicated, throw-away local Hardhat chain.
//
// Usage: node scripts/benchmark.ts [--devices 10] [--events 8] [--seed 42] [--trials 10] [--out docs/results]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { Ledger, deployPatchLedger } from "../server/chain.ts";
import { Store } from "../server/db.ts";
import { COMPONENTS, typeCode, type RecordType } from "../server/domain.ts";
import { EvidenceVault } from "../server/evidence.ts";
import { TamperLab } from "../server/lab.ts";
import { NO_REF } from "../server/ledger-hash.ts";
import { sha256Hex as sha } from "../server/canonical.ts";
import { PatchLedgerService, type EventInput } from "../server/service.ts";
import { startChain } from "./lib/chainproc.ts";
import { EditableStore, HardenedStore, Unauthorized, type Finding } from "./lib/baselines.ts";

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const num = (name: string, def: number) => {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} must be a positive integer`);
  return v;
};
const DEVICES = num("devices", 10);
const EVENTS = num("events", 8);
const SEED = num("seed", 42);
const TRIALS = num("trials", 10);
const outIdx = argv.indexOf("--out");
const OUT = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : "docs/results");
const log = (...a: unknown[]) => console.log("[bench]", ...a);

// ------------------------------------------------------------------ RNG
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");

// ------------------------------------------------------------------ workload
interface Item {
  idx: number;
  device: number;
  type: RecordType;
  actor: string;
  input: EventInput & { brand?: string; model?: string; year?: number };
  refIdx?: number;
  evidence?: Buffer;
}
const BRANDS: [string, string][] = [["Lenovo", "ThinkPad T470"], ["Dell", "Latitude 5490"], ["HP", "ProBook 440 G6"], ["Acer", "TravelMate P2"], ["ASUS", "ExpertBook B1"]];
const CATS = ["battery", "power", "storage", "memory", "display", "keyboard", "thermal", "board-level", "chassis", "general"];
const REPLACEABLE = ["battery", "storage", "display", "keyboard", "memory", "fan"] as const;

function genWorkload(): Item[] {
  const items: Item[] = [];
  for (let d = 0; d < DEVICES; d++) {
    const [brand, model] = pick(BRANDS);
    items.push({ idx: items.length, device: d, type: "REGISTRATION", actor: "registrar", input: { type: "REGISTRATION", brand, model, year: 2017 + Math.floor(rng() * 6) } });
    const claims: number[] = [];
    const corrected = new Set<number>();
    for (let k = 0; k < EVENTS; k++) {
      const day = new Date(Date.UTC(2024, 0, 1) + Math.floor(rng() * 600) * 86400000).toISOString().slice(0, 10);
      const r = rng();
      const correctable = claims.filter((c) => !corrected.has(c));
      if (r < 0.08 && correctable.length) {
        const t = pick(correctable);
        corrected.add(t);
        items.push({
          idx: items.length,
          device: d,
          type: "CORRECTION",
          actor: items[t].actor,
          refIdx: t,
          input: { type: "CORRECTION", reason: `Synthetic correction of an earlier entry (benchmark item ${t}).`, description: `Corrected synthetic description ${hex(8)}`, result: "pass" },
        });
        continue;
      }
      const type: RecordType = r < 0.35 ? "DIAGNOSTIC" : r < 0.6 ? "REPAIR" : r < 0.75 ? "COMPONENT_REPLACEMENT" : r < 0.92 ? "INSPECTION" : "CUSTODY_TRANSFER";
      const actor = type === "INSPECTION" ? "inspector" : type === "CUSTODY_TRANSFER" ? pick(["registrar", "inspector"]) : pick(["repairer-a", "repairer-b", "inspector"]);
      const component = type === "COMPONENT_REPLACEMENT" ? pick(REPLACEABLE) : pick(COMPONENTS);
      const input: EventInput = { type, claimedAt: day };
      if (type === "CUSTODY_TRANSFER") Object.assign(input, { fromParty: "Synthetic reseller", toParty: "Synthetic buyer (not recorded)" });
      else {
        Object.assign(input, {
          category: pick(CATS),
          component,
          description: `Synthetic ${type.toLowerCase()} entry ${hex(12)} for benchmark device ${d}.`,
          result: type === "COMPONENT_REPLACEMENT" ? "replaced" : pick(["pass", "fail", "repaired", "observed"]),
        });
        if (type === "COMPONENT_REPLACEMENT") input.partOrigin = pick(["new-oem", "new-compatible", "refurbished"]);
        if ((type === "INSPECTION" || type === "DIAGNOSTIC") && rng() < 0.5) input.componentAssertions = [{ component: pick(REPLACEABLE), state: rng() < 0.7 ? "original" : "replaced" }];
      }
      const item: Item = { idx: items.length, device: d, type, actor, input };
      if (type !== "CUSTODY_TRANSFER" && rng() < 0.4) {
        const size = 1500 + Math.floor(rng() * 4500);
        item.evidence = Buffer.from(`SYNTHETIC BENCHMARK EVIDENCE device=${d} item=${item.idx}\n` + hex(size));
      }
      items.push(item);
      claims.push(item.idx);
    }
  }
  return items;
}

// ------------------------------------------------------------------ stats
interface Stats {
  n: number;
  median: number;
  p95: number | null;
  mean: number;
  min: number;
  max: number;
}
function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { n: s.length, median: r(q(0.5)), p95: s.length >= 20 ? r(q(0.95)) : null, mean: r(s.reduce((a, b) => a + b, 0) / s.length), min: r(s[0]), max: r(s[s.length - 1]) };
}

// ------------------------------------------------------------------ main
const workload = genWorkload();
const totalRecords = workload.length;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patchledger-bench-"));
log(`seed=${SEED} devices=${DEVICES} events/device=${EVENTS} records/store=${totalRecords} trials=${TRIALS}`);
log(`working directory ${tmp}`);

const chain = await startChain();
let exitCode = 0;
try {
  const { address, gasUsed: deployGas } = await deployPatchLedger(chain.url);
  const ledger = new Ledger(chain.url, address);
  const bcStore = new Store(path.join(tmp, "blockchain-offchain.sqlite"));
  const svc = new PatchLedgerService(bcStore, ledger, new EvidenceVault(path.join(tmp, "blockchain-evidence")));
  const lab = new TamperLab(svc);
  const editable = new EditableStore(tmp);
  const hardened = new HardenedStore(tmp, false);
  const anchored = new HardenedStore(tmp, true);

  const payloadFor = (item: Item, dev: string, ev?: { id: string; sha: string }) => {
    const { type: _t, refSeq: _r, ...rest } = item.input;
    const p: Record<string, unknown> = { schema: "patchledger.event.v1", type: item.type, device: dev, ...rest, evidence: ev ? [{ id: ev.id, kind: "other", sha256: ev.sha }] : [], nonce: hex(32) };
    if (item.type === "CORRECTION") p.corrected = { description: item.input.description, result: item.input.result };
    return p;
  };

  // ---------------------------------------------------------------- inserts
  const seqMap: Record<string, Map<number, number>> = { editable: new Map(), hardened: new Map(), "hardened-anchored": new Map(), blockchain: new Map() };
  const evMap: Record<string, Map<number, string>> = { editable: new Map(), hardened: new Map(), "hardened-anchored": new Map(), blockchain: new Map() };
  const insertMs: Record<string, number[]> = { editable: [], hardened: [], "hardened-anchored": [], blockchain: [] };
  const pid: string[] = [];
  const devName = (d: number) => `BENCH-${String(d).padStart(4, "0")}`;
  const gasByType: Record<string, number[]> = {};
  const txHashes: string[] = [];

  log("inserting into blockchain store (real transactions)…");
  for (const item of workload) {
    if (item.type === "REGISTRATION") {
      const t0 = performance.now();
      const r = await svc.registerDevice("registrar", { brand: item.input.brand!, model: item.input.model!, year: item.input.year, synthetic: true });
      insertMs.blockchain.push(performance.now() - t0);
      pid[item.device] = r.publicId;
      seqMap.blockchain.set(item.idx, 0);
      (gasByType.REGISTRATION ??= []).push(r.tx.gasUsed);
      txHashes.push(r.tx.txHash);
      continue;
    }
    const p = pid[item.device];
    const evIds: string[] = [];
    if (item.evidence) {
      const e = svc.uploadEvidence(item.actor, p, { buffer: item.evidence, originalname: `bench-${item.idx}.txt`, mimetype: "text/plain" }, { kind: "other" });
      evIds.push(e.evidence.id);
      evMap.blockchain.set(item.idx, e.evidence.id);
    }
    const input = { ...item.input, refSeq: item.refIdx !== undefined ? seqMap.blockchain.get(item.refIdx) : undefined, evidenceIds: evIds };
    const t0 = performance.now();
    const r = await svc.appendEvent(item.actor, p, input);
    insertMs.blockchain.push(performance.now() - t0);
    seqMap.blockchain.set(item.idx, r.seq);
    (gasByType[item.type] ??= []).push(r.tx.gasUsed);
    txHashes.push(r.tx.txHash);
  }

  for (const [id, st] of [["editable", editable], ["hardened", hardened], ["hardened-anchored", anchored]] as const) {
    log(`inserting into ${id} store…`);
    for (const item of workload) {
      const dev = devName(item.device);
      let ev: { id: string; sha: string } | undefined;
      if (item.evidence) {
        const evId = `ev-${item.idx}`;
        ev = { id: evId, sha: st.storeEvidence(evId, item.evidence) };
        evMap[id].set(item.idx, evId);
      }
      const payload = payloadFor(item, dev, ev);
      const ref = item.refIdx !== undefined ? seqMap[id].get(item.refIdx) : undefined;
      const t0 = performance.now();
      const seq = st instanceof EditableStore ? st.append(item.actor, dev, item.type, payload, ref, ev) : st.append(item.actor, dev, item.type, payload, ref);
      insertMs[id].push(performance.now() - t0);
      seqMap[id].set(item.idx, seq);
    }
  }

  // ---------------------------------------------------------------- verification latency
  const verifyMs: Record<string, number[]> = { editable: [], hardened: [], "hardened-anchored": [], blockchain: [] };
  const verifyFindings: Record<string, number> = { editable: 0, hardened: 0, "hardened-anchored": 0, blockchain: 0 };
  for (let d = 0; d < DEVICES; d++) {
    for (const [id, st] of [["editable", editable], ["hardened", hardened], ["hardened-anchored", anchored]] as const) {
      const t0 = performance.now();
      const f = st.verify(devName(d));
      verifyMs[id].push(performance.now() - t0);
      verifyFindings[id] += f.length;
    }
    const t0 = performance.now();
    const r = await svc.checkIntegrity(pid[d]);
    verifyMs.blockchain.push(performance.now() - t0);
    verifyFindings.blockchain += r.findings.filter((f) => f.severity === "error").length;
  }
  log(`baseline verification errors (should be 0): ${JSON.stringify(verifyFindings)}`);

  // ---------------------------------------------------------------- storage
  let calldata = 0;
  for (const h of txHashes) {
    const tx = await ledger.provider.getTransaction(h);
    calldata += tx ? (tx.data.length - 2) / 2 : 0;
  }
  const corrections = workload.filter((w) => w.type === "CORRECTION").length;
  // contract storage written: 4 slots per Record, +1 array-length slot per device, +1 supersededBy slot per correction,
  // +3 global counters (deviceCount/totalRecords) amortised are ignored as constant.
  const onChainSlots = totalRecords * 4 + DEVICES + corrections;
  const allSeries = Object.values(gasByType).flat();
  const storeMeta: Record<string, { name: string; description: string }> = {
    editable: { name: "Editable SQLite", description: "CRUD store; app-level roles; corrections and dispute status updated in place" },
    hardened: { name: "Hardened SQLite", description: "Append-only triggers; SHA-256 hash chain; app-level roles" },
    "hardened-anchored": { name: "Hardened + checkpoints", description: "As hardened, plus head hashes handed to an independent party after every write" },
    blockchain: { name: "PatchLedger (local chain)", description: "Solidity contract enforces roles and append-only links; payloads off-chain, digests on-chain" },
  };
  const sizes: Record<string, number> = { editable: editable.sizeBytes(), hardened: hardened.sizeBytes(), "hardened-anchored": anchored.sizeBytes() };
  bcStore.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  sizes.blockchain = (bcStore.db.prepare("PRAGMA page_count").get() as any).page_count * (bcStore.db.prepare("PRAGMA page_size").get() as any).page_size;

  const stores = (["editable", "hardened", "hardened-anchored", "blockchain"] as const).map((id) => ({
    id,
    ...storeMeta[id],
    insert: stats(insertMs[id]),
    verify: stats(verifyMs[id]),
    throughputPerSec: insertMs[id].length / (insertMs[id].reduce((a, b) => a + b, 0) / 1000),
    storage: {
      offChainBytesPerRecord: sizes[id] / totalRecords,
      onChainBytesPerRecord: id === "blockchain" ? (onChainSlots * 32) / totalRecords : null,
      calldataBytesPerRecord: id === "blockchain" ? calldata / totalRecords : null,
      method:
        id === "blockchain"
          ? "off-chain: SQLite page_count×page_size ÷ records; on-chain: contract storage slots written (4×32 B per record + per-device and per-correction mapping slots), from the struct layout"
          : "SQLite page_count×page_size ÷ records (after WAL checkpoint); evidence files excluded for all stores",
    },
    gas:
      id === "blockchain"
        ? {
            meanPerRecord: allSeries.reduce((a, b) => a + b, 0) / allSeries.length,
            perType: Object.fromEntries(Object.entries(gasByType).map(([t, g]) => [t, { n: g.length, median: stats(g).median }])),
            deployment: deployGas,
          }
        : null,
  }));

  // ---------------------------------------------------------------- scenarios
  type Outcome = "prevented" | "detected" | "undetected";
  type Res = { trials: number; prevented: number; detected: number; undetected: number; protectedRate: number; note: string };
  const STORE_IDS = ["editable", "hardened", "hardened-anchored", "blockchain"] as const;
  const blank = (): Res => ({ trials: 0, prevented: 0, detected: 0, undetected: 0, protectedRate: 0, note: "" });
  const errs = (f: Finding[]) => f.filter((x) => x.severity === "error").length;
  const bcErrs = async (d: number) => (await svc.checkIntegrity(pid[d])).findings.filter((f) => f.severity === "error").length;
  const claimItems = workload.filter((w) => w.type !== "REGISTRATION" && w.type !== "CORRECTION");
  const evItems = workload.filter((w) => w.evidence);
  const shuffled = <T,>(xs: T[]) => xs.map((x) => [rng(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const targets = (pool: Item[]) => {
    const s = shuffled(pool);
    return Array.from({ length: TRIALS }, (_, i) => s[i % s.length]);
  };
  const mutate = (p: any) => {
    p.description = `${p.description ?? ""} [altered]`;
    if (Array.isArray(p.componentAssertions)) p.componentAssertions = p.componentAssertions.map((a: any) => ({ ...a, state: a.state === "original" ? "replaced" : "original" }));
  };
  const scenarios: { id: string; title: string; attacker: string; kind: "attack" | "detection" | "preservation"; results: Record<string, Res> }[] = [];

  async function scenario(
    id: string,
    title: string,
    attacker: string,
    kind: "attack" | "detection" | "preservation",
    pool: Item[],
    run: Record<(typeof STORE_IDS)[number], (t: Item, trial: number) => Promise<Outcome> | Outcome>,
    notes: Partial<Record<(typeof STORE_IDS)[number], string>> = {},
  ) {
    log(`scenario ${id}: ${title}`);
    const results: Record<string, Res> = {};
    const ts = targets(pool);
    for (const sid of STORE_IDS) {
      const r = blank();
      for (let i = 0; i < ts.length; i++) {
        const o = await run[sid](ts[i], i);
        r[o]++;
        r.trials++;
      }
      r.protectedRate = (r.prevented + r.detected) / r.trials;
      r.note = notes[sid] ?? "";
      results[sid] = r;
    }
    scenarios.push({ id, title, attacker, kind, results });
  }

  // S1 — edit a stored claim (and its own hash where one exists)
  await scenario(
    "S1",
    "Unauthorized modification of an existing record",
    "Database administrator edits a claim directly (bypassing the app) and recomputes that record's own digest/hash",
    "attack",
    claimItems,
    {
      editable: (t) => {
        const dev = devName(t.device), seq = seqMap.editable.get(t.idx)!;
        const row = editable.get(dev, seq);
        const before = errs(editable.verify(dev));
        const p = JSON.parse(row.payload);
        mutate(p);
        editable.db.prepare("UPDATE records SET payload=? WHERE device=? AND seq=?").run(JSON.stringify(p), dev, seq);
        const after = errs(editable.verify(dev));
        editable.db.prepare("UPDATE records SET payload=? WHERE device=? AND seq=?").run(row.payload, dev, seq);
        return after > before ? "detected" : "undetected";
      },
      hardened: (t) => {
        const dev = devName(t.device), snap = hardened.snapshot(dev);
        hardened.editOwnHash(dev, seqMap.hardened.get(t.idx)!, mutate);
        const o = errs(hardened.verify(dev)) > 0 ? "detected" : "undetected";
        hardened.restore(dev, snap);
        return o;
      },
      "hardened-anchored": (t) => {
        const dev = devName(t.device), snap = anchored.snapshot(dev);
        anchored.editOwnHash(dev, seqMap["hardened-anchored"].get(t.idx)!, mutate);
        const o = errs(anchored.verify(dev)) > 0 ? "detected" : "undetected";
        anchored.restore(dev, snap);
        return o;
      },
      blockchain: async (t) => {
        const before = await bcErrs(t.device);
        lab.editRecord(pid[t.device], seqMap.blockchain.get(t.idx)!);
        const after = await bcErrs(t.device);
        lab.restoreAll();
        return after > before ? "detected" : "undetected";
      },
    },
    { hardened: "Edits of the newest record leave no broken link and pass local verification", editable: "No integrity metadata covers record content" },
  );

  // S2 — consistent rewrite of the whole chain after the target
  await scenario(
    "S2",
    "Consistent history rewrite",
    "Database administrator edits a claim and recomputes every subsequent hash so the local chain is self-consistent",
    "attack",
    claimItems,
    {
      editable: (t) => {
        const dev = devName(t.device), seq = seqMap.editable.get(t.idx)!;
        const row = editable.get(dev, seq);
        const p = JSON.parse(row.payload);
        mutate(p);
        editable.db.prepare("UPDATE records SET payload=? WHERE device=? AND seq=?").run(JSON.stringify(p), dev, seq);
        const o = errs(editable.verify(dev)) > 0 ? "detected" : "undetected";
        editable.db.prepare("UPDATE records SET payload=? WHERE device=? AND seq=?").run(row.payload, dev, seq);
        return o;
      },
      hardened: (t) => {
        const dev = devName(t.device), snap = hardened.snapshot(dev);
        hardened.consistentRewrite(dev, seqMap.hardened.get(t.idx)!, mutate);
        const o = errs(hardened.verify(dev)) > 0 ? "detected" : "undetected";
        hardened.restore(dev, snap);
        return o;
      },
      "hardened-anchored": (t) => {
        const dev = devName(t.device), snap = anchored.snapshot(dev);
        anchored.consistentRewrite(dev, seqMap["hardened-anchored"].get(t.idx)!, mutate);
        const o = errs(anchored.verify(dev)) > 0 ? "detected" : "undetected";
        anchored.restore(dev, snap);
        return o;
      },
      blockchain: async (t) => {
        const seq = seqMap.blockchain.get(t.idx)!;
        lab.editRecord(pid[t.device], seq);
        // the insider also tries to rewrite the on-chain history by building on the target's predecessor
        const deviceKey = svc.store.getDevice(pid[t.device])!.device_key;
        const recs = await ledger.getRecords(deviceKey);
        let onChainRewritten = false;
        try {
          await ledger.appendRecord(t.actor, { deviceKey, recordType: typeCode("REPAIR"), expectedPrevHash: recs[seq].prevHash, payloadDigest: recs[seq].payloadDigest, refSeq: NO_REF });
          onChainRewritten = true;
        } catch {
          /* StalePrevHash: expected */
        }
        const after = await bcErrs(t.device);
        lab.restoreAll();
        return onChainRewritten ? "undetected" : after > 0 ? "detected" : "undetected";
      },
    },
    { "hardened-anchored": "Detected because the externally held head hash no longer matches", blockchain: "Off-chain rewrite detected; the on-chain rewrite attempt reverted (StalePrevHash)" },
  );

  // S3 — delete an event
  await scenario(
    "S3",
    "Deletion of an event record",
    "Database administrator deletes a record row",
    "attack",
    claimItems,
    {
      editable: (t) => {
        const dev = devName(t.device), seq = seqMap.editable.get(t.idx)!;
        const row = editable.get(dev, seq);
        editable.db.prepare("DELETE FROM records WHERE device=? AND seq=?").run(dev, seq);
        const o = errs(editable.verify(dev)) > 0 ? "detected" : "undetected";
        editable.db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?)").run(row.device, row.seq, row.type, row.actor, row.payload, row.evidence_id, row.evidence_sha, row.ref_seq, row.updated_at);
        return o;
      },
      hardened: (t) => {
        const dev = devName(t.device), snap = hardened.snapshot(dev);
        hardened.deleteRecord(dev, seqMap.hardened.get(t.idx)!);
        const o = errs(hardened.verify(dev)) > 0 ? "detected" : "undetected";
        hardened.restore(dev, snap);
        return o;
      },
      "hardened-anchored": (t) => {
        const dev = devName(t.device), snap = anchored.snapshot(dev);
        anchored.deleteRecord(dev, seqMap["hardened-anchored"].get(t.idx)!);
        const o = errs(anchored.verify(dev)) > 0 ? "detected" : "undetected";
        anchored.restore(dev, snap);
        return o;
      },
      blockchain: async (t) => {
        lab.deleteRecord(pid[t.device], seqMap.blockchain.get(t.idx)!);
        const o = (await bcErrs(t.device)) > 0 ? "detected" : "undetected";
        lab.restoreAll();
        return o;
      },
    },
    { editable: "Only deletions that leave a sequence gap are noticed; deleting the newest record is not", hardened: "Deleting the newest record leaves the remaining chain valid" },
  );

  // S4 — evidence file altered (file-store access only)
  const alterFile = (p: string) => {
    const orig = fs.readFileSync(p);
    fs.writeFileSync(p, Buffer.concat([orig, Buffer.from("\naltered")]));
    return () => fs.writeFileSync(p, orig);
  };
  await scenario(
    "S4",
    "Alteration of a supporting evidence file",
    "Attacker with write access to the evidence file store replaces a file's bytes",
    "attack",
    evItems,
    {
      editable: (t) => {
        const dev = devName(t.device), undo = alterFile(path.join(editable.evDir, evMap.editable.get(t.idx)!));
        const o = errs(editable.verify(dev)) > 0 ? "detected" : "undetected";
        undo();
        return o;
      },
      hardened: (t) => {
        const undo = alterFile(path.join(hardened.evDir, evMap.hardened.get(t.idx)!));
        const o = errs(hardened.verify(devName(t.device))) > 0 ? "detected" : "undetected";
        undo();
        return o;
      },
      "hardened-anchored": (t) => {
        const undo = alterFile(path.join(anchored.evDir, evMap["hardened-anchored"].get(t.idx)!));
        const o = errs(anchored.verify(devName(t.device))) > 0 ? "detected" : "undetected";
        undo();
        return o;
      },
      blockchain: async (t) => {
        lab.alterEvidence(evMap.blockchain.get(t.idx)!, "file");
        const o = (await bcErrs(t.device)) > 0 ? "detected" : "undetected";
        lab.restoreAll();
        return o;
      },
    },
    { editable: "Detected because this baseline also stores SHA-256 digests" },
  );

  // S5 — evidence file and its stored digest altered together
  await scenario(
    "S5",
    "Evidence file and its stored digest replaced together",
    "Attacker with database and file-store access replaces a file and updates the digest stored with it (recomputing that record's own hash where one exists)",
    "attack",
    evItems,
    {
      editable: (t) => {
        const dev = devName(t.device), seq = seqMap.editable.get(t.idx)!, p = path.join(editable.evDir, evMap.editable.get(t.idx)!);
        const row = editable.get(dev, seq);
        const undo = alterFile(p);
        editable.db.prepare("UPDATE records SET evidence_sha=? WHERE device=? AND seq=?").run(sha(fs.readFileSync(p)), dev, seq);
        const o = errs(editable.verify(dev)) > 0 ? "detected" : "undetected";
        undo();
        editable.db.prepare("UPDATE records SET evidence_sha=? WHERE device=? AND seq=?").run(row.evidence_sha, dev, seq);
        return o;
      },
      hardened: (t) => hardenedEvidenceSwap(hardened, t, seqMap.hardened, evMap.hardened),
      "hardened-anchored": (t) => hardenedEvidenceSwap(anchored, t, seqMap["hardened-anchored"], evMap["hardened-anchored"]),
      blockchain: async (t) => {
        lab.alterEvidence(evMap.blockchain.get(t.idx)!, "file-and-db");
        const o = (await bcErrs(t.device)) > 0 ? "detected" : "undetected";
        lab.restoreAll();
        return o;
      },
    },
  );
  function hardenedEvidenceSwap(st: HardenedStore, t: Item, sm: Map<number, number>, em: Map<number, string>): Outcome {
    const dev = devName(t.device), snap = st.snapshot(dev), p = path.join(st.evDir, em.get(t.idx)!);
    const undo = alterFile(p);
    const newSha = sha(fs.readFileSync(p));
    st.editOwnHash(dev, sm.get(t.idx)!, (pl) => (pl.evidence = pl.evidence.map((e: any) => ({ ...e, sha256: newSha }))));
    const o = errs(st.verify(dev)) > 0 ? "detected" : "undetected";
    undo();
    st.restore(dev, snap);
    return o;
  }

  // S6 — unauthorized role through the application / contract
  const unauthorized = (t: Item, i: number) => {
    const kinds = [
      { actor: "buyer", type: "REPAIR" as RecordType },
      { actor: "auditor", type: "COMPONENT_REPLACEMENT" as RecordType },
      { actor: "outsider", type: "DIAGNOSTIC" as RecordType },
      { actor: t.actor === "repairer-b" ? "repairer-a" : "repairer-b", type: "CORRECTION" as RecordType },
    ];
    return kinds[i % kinds.length];
  };
  await scenario(
    "S6",
    "Unauthorized role submits a record",
    "A party without the required role (buyer, auditor, unregistered account, or a different repairer correcting someone else's claim) uses the normal write path",
    "attack",
    claimItems,
    {
      editable: (t, i) => appAttempt(() => {
        const k = unauthorized(t, i);
        editable.append(k.actor, devName(t.device), k.type, { description: "unauthorized", corrected: { description: "x" } }, k.type === "CORRECTION" ? seqMap.editable.get(t.idx) : undefined);
      }),
      hardened: (t, i) => appAttempt(() => {
        const k = unauthorized(t, i);
        hardened.append(k.actor, devName(t.device), k.type, { description: "unauthorized" }, k.type === "CORRECTION" ? seqMap.hardened.get(t.idx) : undefined);
      }),
      "hardened-anchored": (t, i) => appAttempt(() => {
        const k = unauthorized(t, i);
        anchored.append(k.actor, devName(t.device), k.type, { description: "unauthorized" }, k.type === "CORRECTION" ? seqMap["hardened-anchored"].get(t.idx) : undefined);
      }),
      blockchain: async (t, i) => {
        const k = unauthorized(t, i);
        try {
          await svc.appendEvent(k.actor, pid[t.device], {
            type: k.type,
            description: "unauthorized attempt",
            reason: "unauthorized correction",
            category: "general",
            result: "pass",
            component: "battery",
            partOrigin: "unknown",
            refSeq: k.type === "CORRECTION" ? seqMap.blockchain.get(t.idx) : undefined,
          });
          return "undetected";
        } catch (e: any) {
          return e?.status === 403 ? "prevented" : "undetected";
        }
      },
    },
    { editable: "Rejected by application code; relies on every write going through the application", blockchain: "Reverted by the contract (NotAuthorized / NotOriginalActor)" },
  );
  function appAttempt(fn: () => void): Outcome {
    try {
      fn();
      return "undetected";
    } catch (e) {
      return e instanceof Unauthorized ? "prevented" : "undetected";
    }
  }

  // S7 — insider forges a record attributed to an authorized party
  await scenario(
    "S7",
    "Insider forges a record in an authorized party's name",
    "Operator of the record store inserts a well-formed repair record attributed to an authorized repairer, without that repairer's key",
    "attack",
    claimItems,
    {
      editable: (t) => {
        const dev = devName(t.device);
        const before = errs(editable.verify(dev));
        const seq = editable.rows(dev).length;
        editable.db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?)").run(dev, seq, "REPAIR", "repairer-a", JSON.stringify({ description: "forged" }), null, null, null, new Date().toISOString());
        const o = errs(editable.verify(dev)) > before ? "detected" : "undetected";
        editable.db.prepare("DELETE FROM records WHERE device=? AND seq=?").run(dev, seq);
        return o;
      },
      hardened: (t) => forge(hardened, t),
      "hardened-anchored": (t) => forge(anchored, t),
      blockchain: async (t) => {
        const device = svc.store.getDevice(pid[t.device])!;
        try {
          await ledger.appendRecord("outsider", { deviceKey: device.device_key, recordType: typeCode("REPAIR"), payloadDigest: device.device_key, refSeq: NO_REF });
          return "undetected";
        } catch {
          // fall back to an off-chain-only forgery and see whether the checker notices
          const n = svc.store.listEvents(pid[t.device]).length;
          const tmpl = svc.store.listEvents(pid[t.device])[n - 1];
          svc.store.insertEvent({ ...tmpl, seq: n, type: "REPAIR", actor_id: "repairer-a", actor_address: ledger.addressOf("repairer-a") });
          const detected = (await bcErrs(t.device)) > 0;
          svc.store.db.prepare("DELETE FROM events WHERE public_id=? AND seq=?").run(pid[t.device], n);
          return detected ? "prevented" : "undetected";
        }
      },
    },
    {
      hardened: "Hash chains without per-party signatures cannot attribute records; the forged record is correctly hashed",
      blockchain: "The insider lacks the repairer's key, so the transaction reverts; an off-chain-only row is flagged UNANCHORED_RECORD",
    },
  );
  function forge(st: HardenedStore, t: Item): Outcome {
    const dev = devName(t.device), snap = st.snapshot(dev);
    st.forgeAppend("repairer-a", dev, "REPAIR", { description: "forged" }, null);
    const o = errs(st.verify(dev)) > 0 ? "detected" : "undetected";
    st.restore(dev, snap);
    return o;
  }

  // S8 — hide or overwrite an unresolved dispute
  await scenario(
    "S8",
    "Attempt to hide or overwrite an unresolved dispute",
    "A buyer's challenge is open; the record-store operator tries to make it disappear (status edit, forged resolution, or deletion)",
    "attack",
    claimItems.filter((c) => c.actor !== "buyer"),
    {
      editable: (t) => {
        const dev = devName(t.device);
        const id = editable.append("buyer", dev, "CHALLENGE", { reason: "benchmark challenge" }, seqMap.editable.get(t.idx));
        editable.db.prepare("UPDATE disputes SET status='resolved', resolver='auditor' WHERE id=?").run(id);
        return editable.openDisputes(dev) === 0 && errs(editable.verify(dev)) === 0 ? "undetected" : "detected";
      },
      hardened: (t) => hideDispute(hardened, t, seqMap.hardened),
      "hardened-anchored": (t) => hideDispute(anchored, t, seqMap["hardened-anchored"]),
      blockchain: async (t) => {
        const p = pid[t.device];
        const device = svc.store.getDevice(p)!;
        const target = seqMap.blockchain.get(t.idx)!;
        const ch = await svc.appendEvent("buyer", p, { type: "CHALLENGE", refSeq: target, reason: "benchmark challenge" });
        let hidden = false;
        try {
          await svc.appendEvent("buyer", p, { type: "RESOLUTION", refSeq: ch.seq, outcome: "CLAIM_UPHELD", reason: "self-serving resolution" });
          hidden = true;
        } catch {
          /* NotAuthorized */
        }
        lab.deleteRecord(p, ch.seq);
        const stillOpen = Number(await ledger.contract.openDisputeCount(device.device_key)) > 0;
        const flagged = (await bcErrs(t.device)) > 0;
        lab.restoreAll();
        // leave the dispute resolved properly so later trials start clean
        await svc.appendEvent("auditor", p, { type: "RESOLUTION", refSeq: ch.seq, outcome: "INCONCLUSIVE", reason: "benchmark cleanup" });
        return hidden ? "undetected" : stillOpen && flagged ? "prevented" : stillOpen || flagged ? "detected" : "undetected";
      },
    },
    {
      editable: "Dispute status is an editable column",
      hardened: "A correctly hashed resolution forged in the auditor's name is indistinguishable from a real one",
      blockchain: "Non-auditor resolution reverts; open-dispute state lives in the contract; deleting the off-chain copy is flagged",
    },
  );
  function hideDispute(st: HardenedStore, t: Item, sm: Map<number, number>): Outcome {
    const dev = devName(t.device), snap = st.snapshot(dev);
    const ch = st.append("buyer", dev, "CHALLENGE", { reason: "benchmark challenge" }, sm.get(t.idx));
    st.forgeAppend("auditor", dev, "RESOLUTION", { outcome: "CLAIM_UPHELD", reason: "forged" }, ch);
    const o = st.openDisputes(dev) === 0 && errs(st.verify(dev)) === 0 ? "undetected" : "detected";
    st.restore(dev, snap);
    return o;
  }

  // S9 — evidence digest reuse
  await scenario(
    "S9",
    "Reuse of a previously submitted evidence digest",
    "A byte-identical receipt is submitted again for a different device",
    "detection",
    evItems,
    {
      editable: (t) => (editable.reuseCount(sha(t.evidence!)) > 0 ? "detected" : "undetected"),
      hardened: (t) => (hardened.reuseCount(sha(t.evidence!)) > 0 ? "detected" : "undetected"),
      "hardened-anchored": (t) => (anchored.reuseCount(sha(t.evidence!)) > 0 ? "detected" : "undetected"),
      blockchain: (t) => {
        const other = pid[(t.device + 1) % DEVICES];
        const r = svc.uploadEvidence("repairer-a", other, { buffer: t.evidence!, originalname: "reused.txt", mimetype: "text/plain" }, { kind: "purchase-receipt" });
        return r.warnings.length > 0 ? "detected" : "undetected";
      },
    },
    { editable: "Same digest-lookup query in every store: an analysis feature, not a blockchain property" },
  );

  // S10 — conflicting component claims
  const devicesPool = Array.from({ length: DEVICES }, (_, d) => workload.find((w) => w.device === d && w.type === "REGISTRATION")!);
  await scenario(
    "S10",
    "Conflicting claims about a component replacement",
    "One repairer records a battery replacement; a later inspection asserts the original battery",
    "detection",
    devicesPool,
    {
      editable: (t) => conflictTrial(editable, devName(t.device)),
      hardened: (t) => conflictTrial(hardened, devName(t.device)),
      "hardened-anchored": (t) => conflictTrial(anchored, devName(t.device)),
      blockchain: async (t) => {
        const p = pid[t.device];
        const before = (await svc.getPassport(p)).conflicts.filter((c) => c.status === "open").length;
        await svc.appendEvent("repairer-a", p, { type: "COMPONENT_REPLACEMENT", component: "battery", partOrigin: "new-compatible", description: "bench replacement", result: "replaced" });
        await svc.appendEvent("inspector", p, { type: "INSPECTION", description: "bench inspection", result: "pass", componentAssertions: [{ component: "battery", state: "original" }] });
        const after = (await svc.getPassport(p)).conflicts.filter((c) => c.status === "open").length;
        return after > before ? "detected" : "undetected";
      },
    },
  );
  function conflictTrial(st: EditableStore | HardenedStore, dev: string): Outcome {
    const before = st.conflicts(dev);
    st.append("repairer-a", dev, "COMPONENT_REPLACEMENT", { component: "battery", componentAssertions: [{ component: "battery", state: "replaced" }] });
    st.append("inspector", dev, "INSPECTION", { componentAssertions: [{ component: "battery", state: "original" }] });
    return st.conflicts(dev) > before ? "detected" : "undetected";
  }

  // S11 — correction preserves history
  const corrected = new Set(workload.filter((w) => w.type === "CORRECTION").map((w) => w.refIdx));
  await scenario(
    "S11",
    "Correction preserves the earlier claim",
    "The original author corrects a claim through the normal write path; is the original wording still retrievable?",
    "preservation",
    shuffled(claimItems.filter((c) => !corrected.has(c.idx))).slice(0, TRIALS),
    {
      editable: (t) => preserveTrial(editable, t, seqMap.editable),
      hardened: (t) => preserveTrial(hardened, t, seqMap.hardened),
      "hardened-anchored": (t) => preserveTrial(anchored, t, seqMap["hardened-anchored"]),
      blockchain: async (t) => {
        const p = pid[t.device];
        const seq = seqMap.blockchain.get(t.idx)!;
        const original = svc.store.listEvents(p).find((e) => e.seq === seq)!.payload;
        try {
          await svc.appendEvent(t.actor, p, { type: "CORRECTION", refSeq: seq, reason: "benchmark correction", description: "corrected wording" });
        } catch {
          /* already superseded by an earlier trial: the original is still checked below */
        }
        const now = svc.store.listEvents(p).find((e) => e.seq === seq)!.payload;
        return now === original ? "prevented" : "undetected";
      },
    },
    { editable: "Conventional CRUD correction overwrites the claim in place", blockchain: "Correction is a new record; the original is unchanged on- and off-chain" },
  );
  function preserveTrial(st: EditableStore | HardenedStore, t: Item, sm: Map<number, number>): Outcome {
    const dev = devName(t.device), seq = sm.get(t.idx)!;
    const original = st.get(dev, seq).payload;
    try {
      st.append(t.actor, dev, "CORRECTION", { reason: "benchmark correction", corrected: { description: "corrected wording" } }, seq);
    } catch {
      /* ignore */
    }
    return st.get(dev, seq).payload === original ? "prevented" : "undetected";
  }

  // ---------------------------------------------------------------- output
  const result = {
    schema: "patchledger.benchmark.v1",
    generatedAt: new Date().toISOString(),
    config: {
      devices: DEVICES,
      eventsPerDevice: EVENTS,
      seed: SEED,
      trials: TRIALS,
      totalRecords,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      hardhat: createRequire(import.meta.url)("hardhat/package.json").version,
      solc: "0.8.28 (optimizer 200 runs)",
    },
    workload: { typeMix: Object.fromEntries(Object.entries(Object.groupBy(workload, (w) => w.type)).map(([k, v]) => [k, v!.length])), evidenceFiles: evItems.length },
    baselineVerificationErrors: verifyFindings,
    stores,
    scenarios,
    notes: [
      "Measured directly: insert latency (one record, application path, excluding evidence-file upload), full-history verification latency per device, throughput (records ÷ summed insert time, single sequential client), SQLite size, gas and calldata from transaction receipts.",
      "Simulated: attack outcomes. Each attack is actually executed against the store, then that store's own verifier is run. P = prevented (the operation was rejected), D = applied but detected, U = applied and not detected.",
      "The local Hardhat chain automines every transaction instantly on one node; real deployments add block/consensus latency (seconds) and replication. Latencies here are lower bounds for the blockchain design.",
      "Blockchain verification includes RPC reads of the on-chain records and re-hashing of evidence files, so it is not directly comparable to an in-process SQLite scan.",
      "On-chain bytes per record are computed from the contract's storage layout, not measured from node disk usage.",
      "Insider model: the attacker controls the off-chain database and file store but not other parties' signing keys. In this prototype the server holds all demo keys for convenience, which a production deployment must not do.",
      "The hardened baseline with external checkpoints detects rewrites of already-checkpointed history as well as the blockchain does; its remaining gap is attribution (no per-party signatures) and the operator's ability to append records in others' names.",
      "Single run on one machine; results are descriptive. No statistical significance testing was performed; repeat with several seeds to assess variability.",
    ],
  };
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const base = `benchmark-seed${SEED}-${DEVICES}x${EVENTS}-${stamp}`;
  const md = renderMarkdown(result);
  fs.writeFileSync(path.join(OUT, base + ".json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, base + ".md"), md);
  fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, "latest.md"), md);
  log(`wrote ${path.relative(process.cwd(), path.join(OUT, base))}.{json,md} and latest.{json,md}`);
  for (const s of stores) log(`${s.name.padEnd(28)} insert median ${s.insert.median.toFixed(3)} ms · verify median ${s.verify.median.toFixed(3)} ms · ${s.throughputPerSec.toFixed(0)} rec/s`);
  for (const sc of scenarios) log(`${sc.id} ${STORE_IDS.map((id) => `${id}=${Math.round(sc.results[id].protectedRate * 100)}%`).join(" ")}`);
  ledger.provider.destroy();
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await chain.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);

function renderMarkdown(r: any): string {
  const L: string[] = [];
  const f = (v: number | null) => (v === null ? "—" : v < 1 ? v.toFixed(3) : v.toFixed(2));
  L.push(`# PatchLedger benchmark report`);
  L.push("");
  L.push(`Generated ${r.generatedAt} · seed ${r.config.seed} · ${r.config.devices} devices × ${r.config.eventsPerDevice} events = ${r.config.totalRecords} records per store · ${r.config.trials} trials per scenario`);
  L.push(`Environment: Node ${r.config.node}, ${r.config.platform}/${r.config.arch}, ${r.config.cpu}, Hardhat ${r.config.hardhat}, solc ${r.config.solc}`);
  L.push("");
  L.push(`Workload mix: ${Object.entries(r.workload.typeMix).map(([k, v]) => `${k} ${v}`).join(", ")}; ${r.workload.evidenceFiles} evidence files.`);
  L.push(`Baseline verification errors before attacks (expected 0): ${JSON.stringify(r.baselineVerificationErrors)}`);
  L.push("");
  L.push("## Performance and storage (direct measurements)");
  L.push("");
  L.push("| Store | Insert median ms | Insert p95 ms | Throughput rec/s | Verify median ms | Verify p95 ms | Off-chain B/rec | On-chain B/rec | Calldata B/rec | Mean gas/rec |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.stores)
    L.push(
      `| ${s.name} | ${f(s.insert.median)} | ${f(s.insert.p95)} | ${s.throughputPerSec.toFixed(0)} | ${f(s.verify.median)} | ${f(s.verify.p95)} | ${s.storage.offChainBytesPerRecord.toFixed(0)} | ${s.storage.onChainBytesPerRecord === null ? "—" : s.storage.onChainBytesPerRecord.toFixed(0)} | ${s.storage.calldataBytesPerRecord === null ? "—" : s.storage.calldataBytesPerRecord.toFixed(0)} | ${s.gas ? s.gas.meanPerRecord.toFixed(0) : "—"} |`,
    );
  L.push("");
  L.push("p95 is reported only when n ≥ 20. Verification is per device (full history); n = number of devices.");
  const g = r.stores.find((s: any) => s.gas)?.gas;
  if (g) {
    L.push("");
    L.push(`### Gas by record type (deployment: ${g.deployment} gas)`);
    L.push("");
    L.push("| Record type | n | Median gas |");
    L.push("|---|---|---|");
    for (const [t, v] of Object.entries(g.perType) as any) L.push(`| ${t} | ${v.n} | ${v.median} |`);
  }
  L.push("");
  L.push("## Attack and integrity scenarios (simulated attacks, actually executed)");
  L.push("");
  L.push("Cells: protected rate (prevented + detected) and counts P/D/U out of trials. For S11, P means the original claim was preserved.");
  L.push("");
  L.push(`| Scenario | ${r.stores.map((s: any) => s.name).join(" | ")} |`);
  L.push(`|---|${r.stores.map(() => "---").join("|")}|`);
  for (const sc of r.scenarios) {
    L.push(
      `| **${sc.id}** ${sc.title} | ${r.stores
        .map((s: any) => {
          const x = sc.results[s.id];
          return `${Math.round(x.protectedRate * 100)}% (${x.prevented}P/${x.detected}D/${x.undetected}U)`;
        })
        .join(" | ")} |`,
    );
  }
  L.push("");
  for (const sc of r.scenarios) {
    L.push(`- **${sc.id}** — attacker: ${sc.attacker}.`);
    for (const s of r.stores) if (sc.results[s.id].note) L.push(`  - ${s.name}: ${sc.results[s.id].note}`);
  }
  L.push("");
  L.push("## Notes and limitations");
  L.push("");
  for (const n of r.notes) L.push(`- ${n}`);
  return L.join("\n") + "\n";
}
