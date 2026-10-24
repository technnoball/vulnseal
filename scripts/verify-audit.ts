// Re-verify an exported audit report offline, optionally comparing it with a live chain.
// Usage: node scripts/verify-audit.ts <audit.json> [--rpc http://127.0.0.1:8545]
import fs from "node:fs";
import { Contract } from "ethers";
import { loadArtifact, makeProvider } from "../server/chain.ts";
import { verifyAuditExport } from "../server/integrity.ts";

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--rpc");
if (!file) {
  console.error("usage: node scripts/verify-audit.ts <audit.json> [--rpc URL]");
  process.exit(2);
}
const x = JSON.parse(fs.readFileSync(file, "utf8"));
const res = verifyAuditExport(x);
console.log(`${file}: ${x.log?.length ?? 0} log entries, head ${x.chain?.logHead}`);
console.log(`  offline: ${res.ok ? "every entry hash and link recomputes" : res.problems.join("; ")}`);
console.log(`  findings recorded in the export: ${x.findings?.length ?? 0} (${x.ok ? "export says consistent" : "export says inconsistent"})`);
let ok = res.ok;
const rpc = args.includes("--rpc") ? args[args.indexOf("--rpc") + 1] : undefined;
if (rpc) {
  const provider = makeProvider(rpc, x.chain.chainId);
  const c = new Contract(x.chain.contract, loadArtifact().abi, provider);
  const last = x.log[x.log.length - 1];
  const onchain = last ? await c.logEntries(last.seq) : null;
  const count = Number(await c.logCount());
  const same = !last || onchain === last.entryHash;
  console.log(`  live chain: entry #${last?.seq} ${same ? "matches" : "DIFFERS"}; chain now has ${count} entries${count > (x.log?.length ?? 0) ? " (newer than the export)" : ""}`);
  ok = ok && same;
  provider.destroy();
}
process.exit(ok ? 0 : 1);
