// Independently verify an exported PatchLedger history (no PatchLedger server needed).
// Usage: node scripts/verify-export.ts <export.json> [--rpc http://127.0.0.1:8545] [--evidence-dir data/evidence]
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider } from "ethers";
import { canonicalize, payloadDigest, sha256Hex } from "../server/canonical.ts";
import { computeRecordHash, deviceKeyFor, ZERO_HASH } from "../server/ledger-hash.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--rpc" && args[args.indexOf(a) - 1] !== "--evidence-dir");
if (!file) {
  console.error("usage: node scripts/verify-export.ts <export.json> [--rpc URL] [--evidence-dir DIR]");
  process.exit(2);
}
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const x = JSON.parse(fs.readFileSync(file, "utf8"));
const problems: string[] = [];
const ok = (cond: boolean, msg: string) => {
  if (!cond) problems.push(msg);
};

ok(x.format === "patchledger.export.v1", "unknown export format");
ok(deviceKeyFor(x.device.publicId) === x.device.deviceKey, "device key does not derive from the public ID");
let prev = ZERO_HASH;
const committedEvidence = new Map<string, string>();
for (const r of x.records) {
  const p = JSON.parse(r.canonicalPayload);
  ok(canonicalize(p) === r.canonicalPayload, `#${r.seq}: payload is not canonical`);
  ok(payloadDigest(r.canonicalPayload) === r.payloadDigest, `#${r.seq}: payload digest mismatch`);
  ok(r.prevHash === prev, `#${r.seq}: does not link to the previous record`);
  const h = computeRecordHash(x.chain.chainId, x.chain.contract, x.device.deviceKey, r);
  ok(h === r.recordHash, `#${r.seq}: record hash does not recompute`);
  for (const e of p.evidence ?? []) committedEvidence.set(e.id, e.sha256);
  prev = r.recordHash;
}
ok(prev === x.headHash, "head hash does not match the last record");
for (const e of x.evidence) ok(committedEvidence.get(e.id) === e.sha256, `evidence ${e.id}: listed digest differs from the committed digest`);

const evDir = opt("--evidence-dir");
if (evDir) {
  for (const e of x.evidence) {
    const p = path.join(evDir, e.storedName ?? "");
    if (!fs.existsSync(p)) problems.push(`evidence ${e.id}: file not found in ${evDir}`);
    else ok(sha256Hex(fs.readFileSync(p)) === committedEvidence.get(e.id), `evidence ${e.id}: file bytes do not match the committed SHA-256`);
  }
}

const rpc = opt("--rpc");
if (rpc) {
  const abi = ["function getRecords(bytes32) view returns ((bytes32 recordHash, bytes32 prevHash, bytes32 payloadDigest, address actor, uint40 timestamp, uint8 recordType, uint8 outcome, uint32 refSeq)[])"];
  const c = new Contract(x.chain.contract, abi, new JsonRpcProvider(rpc));
  try {
    const recs = await c.getRecords(x.device.deviceKey);
    ok(recs.length >= x.records.length, `chain has ${recs.length} records but the export has ${x.records.length}`);
    x.records.forEach((r: any) => ok(recs[r.seq]?.recordHash === r.recordHash, `#${r.seq}: record hash differs from the live chain`));
    if (recs.length > x.records.length) console.log(`note: the chain has ${recs.length - x.records.length} newer record(s) than this export`);
  } catch (e) {
    problems.push(`could not query ${rpc}: ${(e as Error).message}`);
  }
}

console.log(`${x.device.publicId}: ${x.records.length} records, ${x.evidence.length} evidence digests, head ${x.headHash}`);
console.log(`checks: canonical payloads, payload digests, record hashes, hash links${evDir ? ", evidence files" : ""}${rpc ? ", live chain" : ""}`);
if (problems.length) {
  console.log(`FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PASS — the exported history is internally consistent" + (rpc ? " and matches the chain" : ""));
process.exit(0);
