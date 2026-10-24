// VulnSeal comparative benchmark.
//   editable           conventional, editable SQLite submission record
//   hardened           append-only, hash-chained, operator-signed SQLite log
//   hardened-anchored  as hardened, plus head checkpoints held by an independent party
//   blockchain         the real VulnSeal contract and service on a throw-away local chain
//
// Usage: node scripts/benchmark.ts [--reports 40] [--seed 42] [--trials 10] [--out docs/results]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { hexlify } from "ethers";
import type { Ledger } from "../server/chain.ts";
import { REPORT_SCHEMA, REVEAL_FORMAT, computeCommitment, fieldsDigest, type ReportFields } from "../server/commitment.ts";
import { Store } from "../server/db.ts";
import { DECISION, DISPUTE_KIND, RELATION, ST } from "../server/domain.ts";
import { Keyring } from "../server/keys.ts";
import { TamperLab } from "../server/lab.ts";
import { verifyReceipt as verifyChainReceipt } from "../server/receipt.ts";
import { VulnSealService, type Viewer } from "../server/service.ts";
import { Vault } from "../server/vault.ts";
import { EditableDesign, HardenedDesign, OFFCHAIN_CHAIN_ID, OPERATOR_CONTRACT, Rejected, type CentralDesign, type Receipt } from "./lib/baselines.ts";
import { startChain } from "./lib/chainproc.ts";
import { initConsortium } from "./lib/consortium.ts";

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const num = (name: string, def: number) => {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} must be a positive integer`);
  return v;
};
const REPORTS = num("reports", 40);
const SEED = num("seed", 42);
const TRIALS = num("trials", 10);
const OUT = path.resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "docs/results");
const log = (...a: unknown[]) => console.log("[bench]", ...a);

// ------------------------------------------------------------------ seeded RNG and workload
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
const RESEARCHERS = ["basalt", "quillfox", "nightjar"] as const;
const TRIAGE = { 1: "ashgrove-triage", 2: "kestrel-triage", 3: "tamarind-triage" } as Record<number, string>;
const COMPONENTS = ["export endpoint", "session handling", "upload worker", "share links", "password reset mail", "image parser", "coupon field"];
const FLAWS = ["ignores the tenant filter", "keeps sessions after logout", "hangs on oversized metadata", "reflects input without encoding", "exposes full account numbers"];

function syntheticReport(i: number, similarTo?: ReportFields): ReportFields {
  const token = `ref-${hex(10)}`;
  if (similarTo) return { ...similarTo, title: `${similarTo.title.replace(/ref-[0-9a-f]+/, token)}`, scope: `${similarTo.scope} (other deployment)` };
  const comp = pick(COMPONENTS);
  const flaw = pick(FLAWS);
  return {
    title: `Synthetic finding ${i}: ${comp} ${flaw} [${token}]`,
    description: `SYNTHETIC BENCHMARK REPORT ${token}. The fictional ${comp} ${flaw}. ${hex(40)}`,
    impact: `Fictional impact for ${token}.`,
    reproduction: `1. Open the fictional ${comp}. 2. Trigger the condition. 3. Observe. (${token})`,
    scope: `${comp.replace(/ /g, "-")}.bench.example (fictional)`,
    severity: pick(["low", "medium", "high"]),
    evidence: [],
  };
}

interface Work {
  i: number;
  researcher: string;
  program: number;
  fields: ReportFields;
  verdict: "valid" | "invalid";
}
const workload: Work[] = Array.from({ length: REPORTS }, (_, i) => ({ i, researcher: pick(RESEARCHERS), program: 1 + Math.floor(rng() * 3), fields: syntheticReport(i + 1), verdict: rng() < 0.7 ? "valid" : "invalid" }));
// cross-program pairs for association/dispute load
const pairs: [number, number][] = [];
for (let k = 0; k + 1 < workload.length && pairs.length < Math.max(1, Math.floor(REPORTS / 5)); k += 2) {
  const a = workload[k], b = workload.slice(k + 1).find((w) => w.program !== a.program);
  if (b && !pairs.some(([x, y]) => [x, y].includes(a.i) || [x, y].includes(b.i))) pairs.push([a.i, b.i]);
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
  if (!s.length) return { n: 0, median: 0, p95: null, mean: 0, min: 0, max: 0 };
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { n: s.length, median: r(q(0.5)), p95: s.length >= 20 ? r(q(0.95)) : null, mean: r(s.reduce((a, b) => a + b, 0) / s.length), min: r(s[0]), max: r(s[s.length - 1]) };
}
const time = async <T,>(bucket: number[], fn: () => Promise<T> | T): Promise<T> => {
  const t0 = performance.now();
  const r = await fn();
  bucket.push(performance.now() - t0);
  return r;
};

// ------------------------------------------------------------------ setup
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vulnseal-bench-"));
log(`seed=${SEED} reports=${REPORTS} pairs=${pairs.length} trials=${TRIALS}`);
const chain = await startChain();
let exitCode = 0;
try {
  const keyring = Keyring.generate();
  const vault = Vault.open(path.join(tmp, "keys"));
  const store = new Store(path.join(tmp, "blockchain-offchain.sqlite"));
  const init = await initConsortium({ rpcUrl: chain.url, keyring, store, appealWindowSeconds: 3600 });
  const ledger: Ledger = init.ledger;
  const gas: Record<string, number[]> = {};
  const calldata: number[] = [];
  const realSend = ledger.send.bind(ledger);
  (ledger as any).send = async (who: string, method: string, args: unknown[]) => {
    const r = await realSend(who, method, args);
    (gas[method] ??= []).push(r.gasUsed);
    const tx = await ledger.provider.getTransaction(r.hash);
    if (tx) calldata.push((tx.data.length - 2) / 2);
    return r;
  };
  const svc = new VulnSealService({ store, vault, ledger, keyring, evidenceDir: path.join(tmp, "evidence") });
  const lab = new TamperLab(svc);
  const v = (id: string): Viewer => svc.viewer(id)!;
  const editable = new EditableDesign(tmp);
  const hardened = new HardenedDesign(tmp, false);
  const anchored = new HardenedDesign(tmp, true);
  const central: CentralDesign[] = [editable, hardened, anchored];
  const DESIGNS = ["editable", "hardened", "hardened-anchored", "blockchain"] as const;
  type DesignId = (typeof DESIGNS)[number];

  // researcher-side vault for the centralised designs (content + nonce), kept by the client
  const centralPkgs = new Map<string, any>();
  const centralCommit = (d: CentralDesign, who: string, program: number, fields: ReportFields) => {
    const nonce = hexlify(new Uint8Array(32).map(() => Math.floor(rng() * 256)));
    const address = keyring.address(who);
    const id = Number((d.db.prepare(d instanceof EditableDesign ? "SELECT COALESCE(MAX(id), 0) + 1 n FROM submissions" : "SELECT COALESCE(MAX(id), 0) + 1 n FROM sealed").get() as any).n);
    const commitment = computeCommitment({ chainId: OFFCHAIN_CHAIN_ID, contract: OPERATOR_CONTRACT, researcher: address, programId: program, policyVersion: 1 }, fieldsDigest(fields), nonce);
    const sealed = vault.sealJson("report", `${d.id}:${id}`, { fields, nonce });
    const receipt = d.commit(who, address, program, commitment, sealed);
    const pkg = { format: REVEAL_FORMAT, commitmentId: receipt.id, chainId: OFFCHAIN_CHAIN_ID, contract: OPERATOR_CONTRACT, researcher: address, programId: program, policyVersion: 1, report: { schema: REPORT_SCHEMA, ...fields }, nonce };
    centralPkgs.set(`${d.id}:${receipt.id}`, pkg);
    return { receipt, pkg };
  };
  const edited = (pkg: any, impact = "Exaggerated after the fact.") => ({ ...pkg, report: { ...pkg.report, impact } });

  // ------------------------------------------------------------------ measured workload
  const perf: Record<DesignId, { commit: number[]; receipt: number[]; transition: number[]; reveal: number[] }> = Object.fromEntries(
    DESIGNS.map((d) => [d, { commit: [], receipt: [], transition: [], reveal: [] }]),
  ) as any;
  const idOf: Record<DesignId, number[]> = { editable: [], hardened: [], "hardened-anchored": [], blockchain: [] };
  const receipts: Record<DesignId, any[]> = { editable: [], hardened: [], "hardened-anchored": [], blockchain: [] };

  log("workload on the blockchain design (real transactions)…");
  for (const w of workload) {
    const r = await time(perf.blockchain.commit, () => svc.commitReport(v(w.researcher), { ...w.fields, programId: w.program }, undefined, { withReceipt: false }));
    idOf.blockchain.push(r.cid);
    receipts.blockchain.push(await svc.receipt(v(w.researcher), r.cid));
    const t = TRIAGE[w.program];
    await time(perf.blockchain.transition, () => svc.acknowledge(v(t), r.cid));
    await time(perf.blockchain.transition, () => svc.requestReveal(v(t), r.cid));
    const sub = await svc.submitReveal(v(w.researcher), r.cid, { mode: "vault" });
    await time(perf.blockchain.reveal, () => svc.verifyReveal(v(t), sub.revealId));
    await time(perf.blockchain.transition, () => svc.triage(v(t), r.cid, "pending-triage", ""));
    await time(perf.blockchain.transition, () => svc.triage(v(t), r.cid, w.verdict, ""));
  }
  for (const d of central) {
    log(`workload on the ${d.id} design…`);
    const p = perf[d.id as DesignId];
    for (const w of workload) {
      const { receipt, pkg } = await time(p.commit, () => centralCommit(d, w.researcher, w.program, w.fields));
      idOf[d.id as DesignId].push(receipt.id);
      receipts[d.id as DesignId].push(receipt);
      const t = TRIAGE[w.program];
      await time(p.transition, () => d.move(t, receipt.id, ST.ACKNOWLEDGED));
      await time(p.transition, () => d.move(t, receipt.id, ST.REVEAL_REQUESTED));
      await time(p.reveal, () => d.reveal(t, receipt.id, pkg));
      await time(p.transition, () => d.move(t, receipt.id, ST.PENDING_TRIAGE));
      await time(p.transition, () => d.move(t, receipt.id, w.verdict === "valid" ? ST.VALID : ST.INVALID));
    }
  }
  // associations and disputes over the same pairs (counted as events, timed as transitions)
  for (const [ia, ib] of pairs) {
    const A = workload[ia], B = workload[ib];
    const aid = (await time(perf.blockchain.transition, () => svc.proposeAssociation(v(TRIAGE[A.program]), idOf.blockchain[ia], idOf.blockchain[ib], RELATION.SAME_ISSUE, "benchmark association"))).aid;
    await time(perf.blockchain.transition, () => svc.reviewAssociation(v(TRIAGE[B.program]), aid, true, "benchmark review"));
    const did = (await time(perf.blockchain.transition, () => svc.openDispute(v(A.researcher), DISPUTE_KIND.PRIORITY, aid, "benchmark dispute"))).did;
    for (const arb of ["arb-holm", "arb-okafor"]) await time(perf.blockchain.transition, () => svc.vote(v(arb), did, DECISION.PRIORITY_FIRST, 100, "benchmark vote"));
    for (const d of central) {
      const p = perf[d.id as DesignId].transition;
      const ids = idOf[d.id as DesignId];
      const caid = await time(p, () => d.propose(TRIAGE[A.program], ids[ia], ids[ib], RELATION.SAME_ISSUE));
      await time(p, () => d.review(TRIAGE[B.program], caid, true));
      const cdid = await time(p, () => d.openDispute(A.researcher, DISPUTE_KIND.PRIORITY, caid));
      for (const arb of ["arb-holm", "arb-okafor"]) await time(p, () => d.vote(arb, cdid, DECISION.PRIORITY_FIRST, 100));
    }
  }
  // receipt verification
  log("receipt verification…");
  for (const r of receipts.blockchain) await time(perf.blockchain.receipt, () => verifyChainReceipt(r, ledger.provider));
  for (const d of central) for (const r of receipts[d.id as DesignId]) await time(perf[d.id as DesignId].receipt, () => d.verifyReceipt(r));

  // ------------------------------------------------------------------ storage
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bcBytes = (store.db.prepare("PRAGMA page_count").get() as any).page_count * (store.db.prepare("PRAGMA page_size").get() as any).page_size;
  const bcEvents = Number(await ledger.read("logCount"));
  const centralEvents = { editable: editable.events, hardened: hardened.events, "hardened-anchored": anchored.events };
  const allGas = Object.values(gas).flat();
  const commitGas = gas.anchorCommitment ?? [];
  const meta: Record<DesignId, { name: string; description: string }> = {
    editable: { name: "Editable SQLite", description: "Conventional record: rows updated in place, editable status log, unsigned receipts checked against the database" },
    hardened: { name: "Hardened log", description: "Append-only, SHA-256 hash-chained entries signed by the operator (Ed25519); triggers block UPDATE/DELETE; signed receipts" },
    "hardened-anchored": { name: "Hardened + checkpoints", description: "As hardened, plus the head hash handed to an independent party after every write" },
    blockchain: { name: "VulnSeal (local chain)", description: "Contract enforces roles, transitions and arbitration rules; commitments and a hash-chained log on-chain; content sealed off-chain" },
  };
  // contract storage per submission: Commitment struct (5 slots) + usedCommitment (1) + log entry (1)
  const ON_CHAIN_BYTES_PER_SUBMISSION = 7 * 32;
  const designs = DESIGNS.map((id) => {
    const p = perf[id];
    const totalCommitSec = p.commit.reduce((a, b) => a + b, 0) / 1000;
    const isChain = id === "blockchain";
    const bytes = isChain ? bcBytes : (central.find((d) => d.id === id) as CentralDesign).size();
    const events = isChain ? bcEvents : centralEvents[id as Exclude<DesignId, "blockchain">];
    return {
      id,
      ...meta[id],
      metrics: {
        commit: stats(p.commit),
        receiptVerify: stats(p.receipt),
        transition: stats(p.transition),
        revealCheck: stats(p.reveal),
        throughputCommitsPerSec: p.commit.length / totalCommitSec,
        storage: {
          bytesPerSubmission: bytes / REPORTS,
          bytesPerEvent: bytes / events,
          events,
          onChainBytesPerSubmission: isChain ? ON_CHAIN_BYTES_PER_SUBMISSION : null,
          calldataBytesPerTx: isChain ? stats(calldata).mean : null,
          method: isChain
            ? "off-chain: SQLite page_count x page_size of the VulnSeal store (sealed reports, reveals, mirror, rationales); on-chain: storage slots per submission from the contract layout (5-slot struct + replay-protection slot + log-entry slot)"
            : "SQLite page_count x page_size after a WAL checkpoint (sealed content included)",
        },
        gas: isChain
          ? {
              meanPerSubmission: commitGas.reduce((a, b) => a + b, 0) / Math.max(1, commitGas.length),
              meanPerTx: allGas.reduce((a, b) => a + b, 0) / Math.max(1, allGas.length),
              perOperation: Object.fromEntries(Object.entries(gas).map(([m, g]) => [m, stats(g).median])),
              deployment: init.gasUsed,
            }
          : null,
      },
    };
  });

  // ------------------------------------------------------------------ scenarios
  type Outcome = "prevented" | "detected" | "undetected" | "passed" | "failed";
  interface Res {
    trials: number;
    prevented: number;
    detected: number;
    undetected: number;
    passed: number;
    note: string;
  }
  const scenarios: { id: string; title: string; attacker: string; kind: "attack" | "functional"; results: Record<string, Res> }[] = [];
  const rejected = async (fn: () => unknown) => {
    try {
      await fn();
      return false;
    } catch (e) {
      return e instanceof Rejected || (e as any)?.contractError || (e as any)?.status === 403 || (e as any)?.status === 409;
    }
  };
  async function scenario(
    id: string,
    title: string,
    attacker: string,
    kind: "attack" | "functional",
    run: Record<DesignId, (trial: number) => Promise<Outcome> | Outcome>,
    notes: Partial<Record<DesignId, string>> = {},
  ) {
    log(`scenario ${id}: ${title}`);
    const results: Record<string, Res> = {};
    for (const d of DESIGNS) {
      const r: Res = { trials: 0, prevented: 0, detected: 0, undetected: 0, passed: 0, note: notes[d] ?? "" };
      for (let t = 0; t < TRIALS; t++) {
        const o = await run[d](t);
        r.trials++;
        if (o === "passed") r.passed++;
        else if (o === "failed") r.undetected++;
        else r[o]++;
      }
      results[d] = r;
    }
    scenarios.push({ id, title, attacker, kind, results });
  }

  // helpers producing a fresh revealed (or reveal-requested) report in each design
  const freshChain = async (who: string, program: number, fields = syntheticReport(1000), reveal = true) => {
    const r = await svc.commitReport(v(who), { ...fields, programId: program }, undefined, { withReceipt: false });
    await svc.acknowledge(v(TRIAGE[program]), r.cid);
    await svc.requestReveal(v(TRIAGE[program]), r.cid);
    if (reveal) {
      const s = await svc.submitReveal(v(who), r.cid, { mode: "vault" });
      await svc.verifyReveal(v(TRIAGE[program]), s.revealId);
    }
    return r.cid;
  };
  const freshCentral = (d: CentralDesign, who: string, program: number, fields = syntheticReport(1000), reveal = true) => {
    const { receipt, pkg } = centralCommit(d, who, program, fields);
    d.move(TRIAGE[program], receipt.id, ST.ACKNOWLEDGED);
    d.move(TRIAGE[program], receipt.id, ST.REVEAL_REQUESTED);
    if (reveal) d.reveal(TRIAGE[program], receipt.id, pkg);
    return { id: receipt.id, pkg };
  };
  const centralFor = (id: DesignId) => central.find((d) => d.id === id)!;
  /** Run an insider trial on a hardened log and roll the log back afterwards, so trials stay independent. */
  const isolated = (d: CentralDesign, fn: () => Outcome): Outcome => {
    if (!(d instanceof HardenedDesign)) return fn();
    const snap = d.snapshot();
    try {
      return fn();
    } finally {
      d.restore(snap);
    }
  };
  const forCentral = (f: (d: CentralDesign, t: number) => Promise<Outcome> | Outcome) =>
    Object.fromEntries((["editable", "hardened", "hardened-anchored"] as const).map((id) => [id, (t: number) => f(centralFor(id), t)])) as Record<Exclude<DesignId, "blockchain">, (t: number) => Promise<Outcome> | Outcome>;
  const commitEntrySeq = (d: HardenedDesign, id: number) => (d.db.prepare("SELECT seq FROM entries WHERE kind = 'commit' AND subject = ?").get(id) as any).seq as number;
  const chainPkg = async (cid: number) => {
    const owner = store.get("SELECT researcher_id FROM reports WHERE cid = ?", cid)!.researcher_id;
    const p: any = await svc.recoveryPackage(v(owner), cid);
    delete p.receipt;
    delete p.warning;
    return p;
  };

  // S1 -----------------------------------------------------------------------------------
  await scenario("S1", "Valid commitment followed by a matching reveal", "Honest researcher and reviewer", "functional", {
    ...forCentral((d) => {
      const { id } = freshCentral(d, "basalt", 1);
      return d.sub(id)!.status === ST.REVEALED ? "passed" : "failed";
    }),
    blockchain: async () => {
      const cid = await freshChain("basalt", 1);
      return (await svc.commitmentOnChain(cid)).status === ST.REVEALED ? "passed" : "failed";
    },
  });

  // S2 -----------------------------------------------------------------------------------
  await scenario("S2", "Reveal containing modified report material", "Researcher reveals content edited after committing", "attack", {
    ...forCentral((d) => {
      const { id, pkg } = freshCentral(d, "quillfox", 2, syntheticReport(1001), false);
      return d.reveal(TRIAGE[2], id, edited(pkg)) === "mismatch" ? "detected" : "undetected";
    }),
    blockchain: async () => {
      const cid = await freshChain("quillfox", 2, syntheticReport(1001), false);
      const s = await svc.submitReveal(v("quillfox"), cid, { mode: "edited", edits: { impact: "Exaggerated after the fact." } });
      const r = await svc.verifyReveal(v(TRIAGE[2]), s.revealId);
      return r.outcome === "mismatch" ? "detected" : "undetected";
    },
  }, { editable: "Commitment check is cryptography, not storage: every design that keeps a commitment detects this" });

  // S3 -----------------------------------------------------------------------------------
  await scenario("S3", "Operator rewrites a stored commitment so a modified reveal is accepted", "Operator with database and signing-key access, colluding with the researcher", "attack", {
    ...forCentral((d) => isolated(d, () => {
      const { id, pkg } = freshCentral(d, "nightjar", 3, syntheticReport(1002), false);
      const bad = edited(pkg);
      const forged = computeCommitment({ chainId: OFFCHAIN_CHAIN_ID, contract: OPERATOR_CONTRACT, researcher: pkg.researcher, programId: 3, policyVersion: 1 }, fieldsDigest(bad.report), pkg.nonce);
      if (d instanceof EditableDesign) d.db.prepare("UPDATE submissions SET commitment = ? WHERE id = ?").run(forged, id);
      else d.consistentRewrite(commitEntrySeq(d, id), (e) => (e.data.commitment = forged));
      const accepted = d.reveal(TRIAGE[3], id, bad) === "match";
      if (!accepted) return "prevented";
      return d.audit().length ? "detected" : "undetected";
    })),
    blockchain: async () => {
      const cid = await freshChain("nightjar", 3, syntheticReport(1002), false);
      const pkg = await chainPkg(cid);
      const bad = edited(pkg);
      const forged = computeCommitment({ chainId: ledger.chainId, contract: ledger.address, researcher: pkg.researcher, programId: 3, policyVersion: pkg.policyVersion }, fieldsDigest(bad.report), pkg.nonce);
      lab.alterCommitment(cid);
      store.run("UPDATE reports SET commitment = ? WHERE cid = ?", forged, cid);
      const s = await svc.submitReveal(v("nightjar"), cid, { mode: "package", package: bad });
      const r = await svc.verifyReveal(v(TRIAGE[3]), s.revealId);
      lab.restoreAll();
      return r.outcome === "match" ? "undetected" : "prevented";
    },
  }, { hardened: "The operator holds the signing key, so a consistent rewrite re-signs cleanly", blockchain: "Verification uses the on-chain commitment; the off-chain edit is also flagged by the audit" });

  // S4 -----------------------------------------------------------------------------------
  await scenario("S4", "Attempted replacement of an earlier commitment", "Researcher replaces a committed report through the normal write path", "attack", {
    ...forCentral((d) => {
      const { id } = freshCentral(d, "basalt", 2, syntheticReport(1003), false);
      const before = d.sub(id)!.commitment;
      d.revise("basalt", id, "0x" + "ab".repeat(32), new Uint8Array(1));
      // is the original commitment still on record, unchanged?
      return d.sub(id)!.commitment === before ? "prevented" : "undetected";
    }),
    blockchain: async () => {
      const cid = await freshChain("basalt", 2, syntheticReport(1003), false);
      const before = await svc.commitmentOnChain(cid);
      await svc.reviseReport(v("basalt"), cid, { ...syntheticReport(1004) });
      const after = await svc.commitmentOnChain(cid);
      const pkg = await chainPkg(cid);
      const stillOpens = await ledger.read<boolean>("verifyOpening", cid, fieldsDigest(pkg.report), pkg.nonce);
      return after.commitment === before.commitment && after.anchoredAt === before.anchoredAt && stillOpens ? "prevented" : "undetected";
    },
  }, { editable: "A conventional edit updates the row in place; the earlier commitment is no longer retrievable", hardened: "Revision is appended; the original entry stays", blockchain: "reviseCommitment() creates a new commitment; the original keeps its time and can still be opened" });

  // S5 -----------------------------------------------------------------------------------
  await scenario("S5", "Two reports associated with the same issue family by qualified reviewers", "Normal workflow: proposal by one program, independent review by the other", "functional", {
    ...forCentral((d) => {
      const a = freshCentral(d, "basalt", 1).id;
      const b = freshCentral(d, "quillfox", 2).id;
      const aid = d.propose(TRIAGE[1], a, b, RELATION.SAME_ISSUE);
      let self = false;
      try {
        d.review(TRIAGE[1], aid, true);
      } catch (e) {
        self = e instanceof Rejected;
      }
      const fam = d.review(TRIAGE[2], aid, true);
      return self && !!fam ? "passed" : "failed";
    }),
    blockchain: async () => {
      const a = await freshChain("basalt", 1);
      const b = await freshChain("quillfox", 2);
      const { aid } = await svc.proposeAssociation(v(TRIAGE[1]), a, b, RELATION.SAME_ISSUE, "same root cause");
      const self = await rejected(() => svc.reviewAssociation(v(TRIAGE[1]), aid, true, "self"));
      await svc.reviewAssociation(v(TRIAGE[2]), aid, true, "confirmed");
      const fam = (await svc.commitmentOnChain(a)).family;
      return self && fam === (await svc.commitmentOnChain(b)).family && /[1-9a-f]/.test(fam.slice(2)) ? "passed" : "failed";
    },
  });

  // S6 -----------------------------------------------------------------------------------
  await scenario("S6", "Two similar-looking reports classified as distinct", "Normal workflow; nothing may be merged automatically", "functional", {
    ...forCentral((d) => {
      const f = syntheticReport(1005);
      const a = freshCentral(d, "basalt", 1, f).id;
      const b = freshCentral(d, "nightjar", 3, syntheticReport(1006, f)).id;
      const aid = d.propose(TRIAGE[3], a, b, RELATION.DISTINCT);
      const fam = d.review(TRIAGE[1], aid, true);
      return fam === null ? "passed" : "failed";
    }),
    blockchain: async () => {
      const f = syntheticReport(1005);
      const a = await freshChain("basalt", 1, f);
      const b = await freshChain("nightjar", 3, syntheticReport(1006, f));
      const { aid } = await svc.proposeAssociation(v(TRIAGE[3]), a, b, RELATION.DISTINCT, "different root causes");
      await svc.reviewAssociation(v(TRIAGE[1]), aid, true, "agreed: distinct");
      const fam = (await svc.commitmentOnChain(a)).family;
      return /^0x0+$/.test(fam) ? "passed" : "failed";
    },
  }, { blockchain: "Hashes of similar reports are unrelated; only a reviewed SAME_ISSUE association creates a family token" });

  // S7 -----------------------------------------------------------------------------------
  await scenario("S7", "Report content disclosed before the process permits it", "Reviewer reads before the reveal; researcher reveals before it is requested", "attack", {
    ...forCentral((d) => {
      const { receipt, pkg } = centralCommit(d, "quillfox", 1, syntheticReport(1007));
      const read = d.canRead(TRIAGE[1], receipt.id);
      let early = false;
      try {
        d.reveal(TRIAGE[1], receipt.id, pkg);
      } catch (e) {
        early = e instanceof Rejected;
      }
      return !read && early ? "prevented" : "undetected";
    }),
    blockchain: async () => {
      const r = await svc.commitReport(v("quillfox"), { ...syntheticReport(1007), programId: 1 }, undefined, { withReceipt: false });
      const view = await svc.reportView(v(TRIAGE[1]), r.cid);
      const early = await rejected(() => svc.submitReveal(v("quillfox"), r.cid, { mode: "vault" }));
      return !view.access.allowed && view.content === null && early ? "prevented" : "undetected";
    },
  }, { editable: "Enforced by the same application rule in every design; content is sealed at rest in all of them" });

  // dispute fixture: a decided round-1 priority dispute between programs 1 and 2
  const decidedCentral = (d: CentralDesign) => {
    const a = freshCentral(d, "basalt", 1).id;
    const b = freshCentral(d, "quillfox", 2).id;
    const aid = d.propose(TRIAGE[1], a, b, RELATION.SAME_ISSUE);
    d.review(TRIAGE[2], aid, true);
    const did = d.openDispute("quillfox", DISPUTE_KIND.PRIORITY, aid);
    return { did };
  };
  const decidedChain = async (votes = 2) => {
    const a = await freshChain("basalt", 1);
    const b = await freshChain("quillfox", 2);
    const { aid } = await svc.proposeAssociation(v(TRIAGE[1]), a, b, RELATION.SAME_ISSUE, "same");
    await svc.reviewAssociation(v(TRIAGE[2]), aid, true, "ok");
    const { did } = await svc.openDispute(v("quillfox"), DISPUTE_KIND.PRIORITY, aid, "priority");
    for (const arb of ["arb-holm", "arb-okafor"].slice(0, votes)) await svc.vote(v(arb), did, DECISION.PRIORITY_FIRST, 100, "first");
    return { did };
  };

  // S8 -----------------------------------------------------------------------------------
  await scenario("S8", "Unauthorized attempt to change a recorded decision", "Operator edits the decision (and covers its tracks) after arbitration", "attack", {
    ...forCentral((d) => isolated(d, () => {
      const { did } = decidedCentral(d);
      for (const arb of ["arb-holm", "arb-okafor"]) d.vote(arb, did, DECISION.PRIORITY_FIRST, 100);
      if (d instanceof EditableDesign) {
        d.db.prepare("UPDATE disputes SET decision = ? WHERE id = ?").run(DECISION.PRIORITY_SECOND, did);
        d.db.prepare("UPDATE votes SET decision = ? WHERE did = ?").run(DECISION.PRIORITY_SECOND, did);
      } else {
        for (const e of d.entries().filter((x) => x.kind === "vote" && x.subject === did)) d.consistentRewrite(e.seq, (m) => (m.data.decision = DECISION.PRIORITY_SECOND));
      }
      const changed = d.decisionHistory(did)[1] === DECISION.PRIORITY_SECOND;
      if (!changed) return "prevented";
      return d.audit().length ? "detected" : "undetected";
    })),
    blockchain: async () => {
      const { did } = await decidedChain();
      store.run("UPDATE disputes SET decision = ? WHERE did = ?", DECISION.PRIORITY_SECOND, did);
      const forged = await rejected(() => ledger.send("outsider", "vote", [did, DECISION.PRIORITY_SECOND, 110, "0x" + "11".repeat(32)]));
      const onchain = await svc.disputeOnChain(did);
      store.run("UPDATE disputes SET decision = ? WHERE did = ?", onchain.decision, did);
      return onchain.decision === DECISION.PRIORITY_FIRST && forged ? "prevented" : "undetected";
    },
  }, { "hardened-anchored": "Rewriting checkpointed entries breaks the externally held head", blockchain: "The decision of record is on-chain; editing the off-chain copy is flagged (DISPUTE_MIRROR_ALTERED)" });

  // S9 -----------------------------------------------------------------------------------
  await scenario("S9", "Dispute followed by a valid appeal", "Normal workflow; both rounds must remain retrievable", "functional", {
    ...forCentral((d) => {
      const { did } = decidedCentral(d);
      for (const arb of ["arb-holm", "arb-okafor"]) d.vote(arb, did, DECISION.PRIORITY_FIRST, 100);
      d.appeal("quillfox", did);
      for (const arb of ["arb-vance", "arb-sato"]) d.vote(arb, did, DECISION.SHARED, 110);
      const h = d.decisionHistory(did);
      return h[1] === DECISION.PRIORITY_FIRST && h[2] === DECISION.SHARED ? "passed" : "failed";
    }),
    blockchain: async () => {
      const { did } = await decidedChain();
      await svc.appeal(v("quillfox"), did, "appeal");
      for (const arb of ["arb-vance", "arb-sato"]) await svc.vote(v(arb), did, DECISION.SHARED, 110, "shared");
      const d = await svc.disputeOnChain(did);
      return d.firstDecision === DECISION.PRIORITY_FIRST && d.decision === DECISION.SHARED && d.status === 4 && d.reversed ? "passed" : "failed";
    },
  }, { editable: "Honest operation keeps the round-1 votes, so both rounds can be reconstructed" });

  // S10 ----------------------------------------------------------------------------------
  await scenario("S10", "Attempt to hide an earlier status event", "Operator removes the record of a failed reveal check", "attack", {
    ...forCentral((d) => isolated(d, () => {
      const { id, pkg } = freshCentral(d, "nightjar", 1, syntheticReport(1008), false);
      d.reveal(TRIAGE[1], id, edited(pkg));
      d.reveal(TRIAGE[1], id, pkg);
      if (d instanceof EditableDesign) {
        d.db.prepare("UPDATE submissions SET mismatches = 0 WHERE id = ?").run(id);
        d.db.prepare("DELETE FROM status_log WHERE sid = ? AND to_status = -1").run(id);
      } else {
        const e = d.entries().find((x) => x.kind === "mismatch" && x.subject === id)!;
        d.consistentDelete(e.seq);
      }
      if (d.sub(id)!.mismatches > 0) return "prevented";
      return d.audit().length ? "detected" : "undetected";
    })),
    blockchain: async () => {
      const cid = await freshChain("nightjar", 1, syntheticReport(1008), false);
      const bad = await svc.submitReveal(v("nightjar"), cid, { mode: "edited", edits: { impact: "Exaggerated after the fact." } });
      await svc.verifyReveal(v(TRIAGE[1]), bad.revealId);
      const good = await svc.submitReveal(v("nightjar"), cid, { mode: "vault" });
      await svc.verifyReveal(v(TRIAGE[1]), good.revealId);
      const ev = store.get("SELECT seq FROM chain_events WHERE kind = 8 AND subject = ? ORDER BY seq LIMIT 1", String(cid))!;
      lab.deleteEvent(ev.seq);
      store.run("UPDATE reports SET mismatches = 0 WHERE cid = ?", cid);
      const onchain = await svc.commitmentOnChain(cid);
      lab.restoreAll();
      store.run("UPDATE reports SET mismatches = ? WHERE cid = ?", onchain.mismatches, cid);
      return onchain.mismatches === 1 ? "prevented" : "undetected";
    },
  }, { hardened: "Consistent deletion renumbers and re-signs the log", blockchain: "The mismatch count and log entry are on-chain; deleting the off-chain copy is flagged (MIRROR_EVENT_MISSING)" });

  // S11 ----------------------------------------------------------------------------------
  const s11Kind = (t: number) => ["conflicted arbitrator votes", "arbitrator votes twice", "operator forges a vote in an arbitrator's name"][t % 3];
  await scenario("S11", "Conflicted or compromised reviewer attempts to adjudicate", "Rotates: conflicted arbitrator; duplicate vote; operator-forged vote", "attack", {
    ...forCentral((d, t) => isolated(d, () => {
      const { did } = decidedCentral(d);
      const k = t % 3;
      const attempt = (fn: () => void): Outcome => {
        try {
          fn();
          return "undetected";
        } catch (e) {
          return e instanceof Rejected ? "prevented" : "undetected";
        }
      };
      if (k === 0) return attempt(() => d.vote("arb-reyes", did, DECISION.PRIORITY_FIRST, 100));
      d.vote("arb-holm", did, DECISION.PRIORITY_FIRST, 100);
      if (k === 1) return attempt(() => d.vote("arb-holm", did, DECISION.PRIORITY_FIRST, 100));
      if (d instanceof EditableDesign) d.db.prepare("INSERT INTO votes(did, round, arbitrator, decision, reason) VALUES (?, 1, 'arb-okafor', ?, 100)").run(did, DECISION.PRIORITY_FIRST);
      else d.forge("vote", did, "arb-okafor", { round: 1, decision: DECISION.PRIORITY_FIRST, reason: 100 });
      const decided = d.decisionHistory(did)[1] === DECISION.PRIORITY_FIRST;
      return !decided ? "prevented" : d.audit().length ? "detected" : "undetected";
    })),
    blockchain: async (t) => {
      const { did } = await decidedChain(0);
      const k = t % 3;
      if (k === 0) return (await rejected(() => svc.vote(v("arb-reyes"), did, DECISION.PRIORITY_FIRST, 100, "conflicted"))) ? "prevented" : "undetected";
      await svc.vote(v("arb-holm"), did, DECISION.PRIORITY_FIRST, 100, "first");
      if (k === 1) return (await rejected(() => svc.vote(v("arb-holm"), did, DECISION.PRIORITY_FIRST, 100, "again"))) ? "prevented" : "undetected";
      const forged = await rejected(() => ledger.send("outsider", "vote", [did, DECISION.PRIORITY_FIRST, 100, "0x" + "22".repeat(32)]));
      return forged && (await svc.disputeOnChain(did)).status === 1 ? "prevented" : "undetected";
    },
  }, { editable: "Conflict and duplicate-vote rules are enforced by every design; only forged attribution separates them", blockchain: "The operator has no arbitrator's key, so a forged vote cannot be signed" });

  // S12 ----------------------------------------------------------------------------------
  const s12Kind = (t: number) => ["missing field", "altered commitment", "holder backdates the receipt", "operator issues a backdated receipt"][t % 4];
  await scenario("S12", "Receipt presented with missing or mismatched information", "Rotates: missing field; altered commitment; holder backdating; operator-issued backdated receipt", "attack", {
    ...forCentral((d, t) => isolated(d, () => {
      const { receipt } = centralCommit(d, "basalt", 2, syntheticReport(1100 + t));
      const k = t % 4;
      let presented: Partial<Receipt> = { ...receipt };
      if (k === 0) delete presented.commitment;
      if (k === 1) presented.commitment = "0x" + "cd".repeat(32);
      if (k === 2) presented.createdAt = receipt.createdAt - 86400;
      if (k === 3) {
        if (d instanceof EditableDesign) d.db.prepare("UPDATE submissions SET created_at = created_at - 86400 WHERE id = ?").run(receipt.id);
        else d.consistentRewrite(commitEntrySeq(d, receipt.id), (m) => (m.ts -= 86400));
        presented = d.receipt(receipt.id);
      }
      return d.verifyReceipt(presented) ? "undetected" : "detected";
    })),
    blockchain: async (t) => {
      const r = await svc.commitReport(v("basalt"), { ...syntheticReport(1100 + t), programId: 2 }, undefined, { withReceipt: false });
      const receipt: any = await svc.receipt(v("basalt"), r.cid);
      const k = t % 4;
      if (k === 0) delete receipt.commitment;
      if (k === 1) receipt.commitment = "0x" + "cd".repeat(32);
      if (k >= 2) receipt.anchoredAt -= 86400;
      const res = await verifyChainReceipt(receipt, ledger.provider);
      return res.verdict === "valid" ? "undetected" : "detected";
    },
  }, { editable: "Unsigned receipts are checked against the operator's own database, so an operator-issued backdated receipt passes", blockchain: "Block times are set by the chain, not by the record-keeping operator" });

  // ------------------------------------------------------------------ disclosure (inspected)
  log("inspecting what each design discloses…");
  const titles = workload.map((w) => w.fields.title.match(/ref-[0-9a-f]+/)![0]);
  const nonces: string[] = store.all("SELECT cid, sealed FROM reports").map((r) => (vault.openJson<any>("report", `report:${r.cid}`, r.sealed).nonce as string).slice(2).toLowerCase());
  // everything a consortium node holds: all transaction input data and all logs
  let chainBlob = "";
  const head = await ledger.provider.getBlockNumber();
  for (let n = 1; n <= head; n++) {
    const b = await ledger.provider.getBlock(n, true);
    for (const tx of b?.prefetchedTransactions ?? []) {
      chainBlob += tx.data.toLowerCase();
      const rc = await ledger.provider.getTransactionReceipt(tx.hash);
      for (const l of rc?.logs ?? []) chainBlob += l.data.toLowerCase() + l.topics.join("").toLowerCase();
    }
  }
  const asHex = (s: string) => Buffer.from(s, "utf8").toString("hex");
  const titleLeaks = titles.filter((t) => chainBlob.includes(asHex(t))).length;
  // positive control: the same search must find what *is* on-chain (the commitment hashes)
  const commitmentsFound = idOf.blockchain.map((cid) => store.get("SELECT commitment FROM reports WHERE cid = ?", cid)!.commitment.slice(2).toLowerCase()).filter((c) => chainBlob.includes(c)).length;
  const nonceLeaks = nonces.filter((n) => chainBlob.includes(n)).length;
  const fileLeaks = (file: string) => {
    const raw = fs.readFileSync(file).toString("latin1");
    return titles.filter((t) => raw.includes(t)).length;
  };
  const anchoredEvents = await ledger.contract.queryFilter(ledger.contract.filters.CommitmentAnchored(), 0, "latest");
  const programsBy = new Map<string, Set<number>>();
  for (const e of anchoredEvents as any[]) {
    const s = programsBy.get(e.args.researcher) ?? new Set<number>();
    s.add(Number(e.args.programId));
    programsBy.set(e.args.researcher, s);
  }
  const crossLinked = [...programsBy.values()].filter((s) => s.size > 1).length;
  const families = new Set((await svc.snapshot()).commitments.map((c) => c.family).filter((f) => !/^0x0+$/.test(f))).size;
  const nDisputes = Number(await ledger.read("disputeCount"));
  const operatorOnly = "operator only (not shared)";
  const disclosure = [
    { item: "Report text found in data shared with other participants", designs: { editable: operatorOnly, hardened: "operator only (signed receipts carry hashes)", "hardened-anchored": "operator only (checkpoints carry one head hash)", blockchain: `${titleLeaks} of ${titles.length} report markers found in all transaction data and logs (control: ${commitmentsFound} of ${titles.length} commitment hashes found by the same search)` } },
    { item: "Secret nonces found in data shared with other participants", designs: { editable: operatorOnly, hardened: operatorOnly, "hardened-anchored": operatorOnly, blockchain: `${nonceLeaks} of ${nonces.length} nonces found in all transaction data and logs` } },
    { item: "Report text readable in the database file without the vault key", designs: { editable: `${fileLeaks(editable.file)} of ${titles.length}`, hardened: `${fileLeaks(path.join(tmp, "hardened.sqlite"))} of ${titles.length}`, "hardened-anchored": `${fileLeaks(path.join(tmp, "hardened-anchored.sqlite"))} of ${titles.length}`, blockchain: `${fileLeaks(path.join(tmp, "blockchain-offchain.sqlite"))} of ${titles.length}` } },
    { item: "Who can read report text with the vault key", designs: { editable: "operator", hardened: "operator", "hardened-anchored": "operator", blockchain: "operator of the off-chain store (prototype keeps vaults server-side)" } },
    { item: "Commitment hashes and submission times", designs: { editable: "operator; receipt holder", hardened: "operator; receipt holder", "hardened-anchored": "operator; receipt holder", blockchain: `every consortium node (${anchoredEvents.length} commitments readable from events)` } },
    { item: "Same researcher linkable across programs", designs: { editable: operatorOnly, hardened: operatorOnly, "hardened-anchored": operatorOnly, blockchain: `every consortium node: ${crossLinked} of ${programsBy.size} researcher addresses appear in more than one program` } },
    { item: "Issue-family linkage between submissions", designs: { editable: operatorOnly, hardened: operatorOnly, "hardened-anchored": operatorOnly, blockchain: `every consortium node (${families} family token(s))` } },
    { item: "Dispute existence, votes and reason codes", designs: { editable: operatorOnly, hardened: operatorOnly, "hardened-anchored": operatorOnly, blockchain: `every consortium node (${nDisputes} disputes)` } },
  ];

  // ------------------------------------------------------------------ output
  const result = {
    schema: "vulnseal.benchmark.v1",
    generatedAt: new Date().toISOString(),
    config: {
      reports: REPORTS,
      seed: SEED,
      trials: TRIALS,
      pairs: pairs.length,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      hardhat: createRequire(import.meta.url)("hardhat/package.json").version,
      solc: "0.8.28 (optimizer 200 runs)",
    },
    designs,
    scenarios,
    scenarioRotation: { S11: [0, 1, 2].map(s11Kind), S12: [0, 1, 2, 3].map(s12Kind) },
    disclosure,
    notes: [
      "Measured directly: latency of committing (computing the commitment, sealing the report, recording it; for the blockchain design this includes signing, the RPC round trip and waiting for the receipt), status transitions, reveal checks and receipt verification; throughput = commits / summed commit time for one sequential client; SQLite sizes; gas and calldata from transaction receipts.",
      "Simulated attacks: each scenario is executed against each design and the design's own verifier then runs. P = prevented (the attacker's goal was rejected), D = applied but detected, U = applied and not detected. Functional scenarios report whether the workflow behaved correctly.",
      "Insider model: the operator controls the off-chain database, the evidence store, the vault key and (for the hardened designs) the log-signing key, but not other participants' private keys. The prototype server holds all demo keys for convenience; a deployment must not.",
      "The local Hardhat chain automines each transaction instantly on one node. Real networks add block and consensus latency, so blockchain latencies here are lower bounds.",
      "Blockchain receipt verification makes about a dozen RPC calls to the node; centralised verification is an in-process lookup. The numbers are not like-for-like.",
      "On-chain bytes per submission come from the contract's storage layout, not from node disk usage; per-event on-chain storage is one 32-byte log-entry slot plus state updates.",
      "The disclosure table is computed by scanning the stored data of each design and every transaction input and log on the chain for the synthetic report markers and nonces.",
      "Single run on one machine; results are descriptive. No statistical significance testing was performed; repeat with several seeds to assess variability.",
    ],
  };
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const base = `benchmark-seed${SEED}-${REPORTS}r-${stamp}`;
  const md = renderMarkdown(result);
  fs.writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, `${base}.md`), md);
  fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, "latest.md"), md);
  log(`wrote ${path.relative(process.cwd(), path.join(OUT, base))}.{json,md} and latest.{json,md}`);
  for (const d of designs) log(`${d.name.padEnd(24)} commit median ${d.metrics.commit.median.toFixed(3)} ms · receipt verify ${d.metrics.receiptVerify.median.toFixed(3)} ms · ${d.metrics.throughputCommitsPerSec.toFixed(0)} commits/s`);
  for (const s of scenarios) log(`${s.id.padEnd(4)} ${DESIGNS.map((id) => { const r = s.results[id]; return `${id}=${s.kind === "functional" ? `${r.passed}/${r.trials}` : `${r.prevented}P${r.detected}D${r.undetected}U`}`; }).join(" ")}`);
  ledger.provider.destroy();
  store.close();
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
  L.push("# VulnSeal benchmark report", "");
  L.push(`Generated ${r.generatedAt} · seed ${r.config.seed} · ${r.config.reports} synthetic reports · ${r.config.pairs} cross-program pairs · ${r.config.trials} trials per scenario`);
  L.push(`Environment: Node ${r.config.node}, ${r.config.platform}/${r.config.arch}, ${r.config.cpu}, Hardhat ${r.config.hardhat}, solc ${r.config.solc}`, "");
  L.push("## Performance and storage (direct measurements)", "");
  L.push("| Design | Commit median ms | Commit p95 ms | Commits/s | Receipt verify median ms | Transition median ms | Reveal check median ms | Bytes/submission | Bytes/event | On-chain B/submission | Gas/commit |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const d of r.designs) {
    const m = d.metrics;
    L.push(`| ${d.name} | ${f(m.commit.median)} | ${f(m.commit.p95)} | ${m.throughputCommitsPerSec.toFixed(0)} | ${f(m.receiptVerify.median)} | ${f(m.transition.median)} | ${f(m.revealCheck.median)} | ${m.storage.bytesPerSubmission.toFixed(0)} | ${m.storage.bytesPerEvent.toFixed(0)} | ${m.storage.onChainBytesPerSubmission ?? "—"} | ${m.gas ? m.gas.meanPerSubmission.toFixed(0) : "—"} |`);
  }
  const g = r.designs.find((d: any) => d.metrics.gas)?.metrics.gas;
  if (g) {
    L.push("", `### Gas by operation (median; deployment ${g.deployment} gas; mean ${g.meanPerTx.toFixed(0)} per transaction)`, "", "| Operation | Median gas |", "|---|---|");
    for (const [k, v] of Object.entries(g.perOperation)) L.push(`| ${k} | ${v} |`);
  }
  L.push("", "## Scenarios (actually executed; attacks are simulated)", "", "Attack cells: protected rate and P/D/U counts. Functional cells: passed/trials.", "");
  L.push(`| Scenario | ${r.designs.map((d: any) => d.name).join(" | ")} |`, `|---|${r.designs.map(() => "---").join("|")}|`);
  for (const s of r.scenarios) {
    L.push(
      `| **${s.id}** ${s.title} | ${r.designs
        .map((d: any) => {
          const x = s.results[d.id];
          return s.kind === "functional" ? `${x.passed}/${x.trials} pass` : `${Math.round(((x.prevented + x.detected) / x.trials) * 100)}% (${x.prevented}P/${x.detected}D/${x.undetected}U)`;
        })
        .join(" | ")} |`,
    );
  }
  L.push("");
  for (const s of r.scenarios) {
    L.push(`- **${s.id}** — ${s.attacker}.`);
    for (const d of r.designs) if (s.results[d.id].note) L.push(`  - ${d.name}: ${s.results[d.id].note}`);
  }
  L.push("", `S11 trials rotate through: ${r.scenarioRotation.S11.join("; ")}. S12 trials rotate through: ${r.scenarioRotation.S12.join("; ")}.`);
  L.push("", "## Disclosure (computed by inspecting stored and on-chain data)", "", `| Item | ${r.designs.map((d: any) => d.name).join(" | ")} |`, `|---|${r.designs.map(() => "---").join("|")}|`);
  for (const x of r.disclosure) L.push(`| ${x.item} | ${r.designs.map((d: any) => x.designs[d.id]).join(" | ")} |`);
  L.push("", "## Notes and limitations", "");
  for (const n of r.notes) L.push(`- ${n}`);
  return L.join("\n") + "\n";
}
