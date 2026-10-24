// Verify a VulnSeal receipt (and optionally a reveal package) directly against a chain.
// Needs only RPC access to the ledger node, not the VulnSeal server.
// Usage: node scripts/verify-receipt.ts <receipt.json> [--reveal package.json] [--rpc http://127.0.0.1:8545]
import fs from "node:fs";
import { makeProvider } from "../server/chain.ts";
import { verifyReceipt } from "../server/receipt.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const file = args.find((a, i) => !a.startsWith("--") && !["--reveal", "--rpc"].includes(args[i - 1]));
if (!file) {
  console.error("usage: node scripts/verify-receipt.ts <receipt.json> [--reveal package.json] [--rpc URL]");
  process.exit(2);
}
const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
const reveal = opt("--reveal") ? JSON.parse(fs.readFileSync(opt("--reveal")!, "utf8")) : undefined;
const rpc = opt("--rpc") ?? "http://127.0.0.1:8545";
const provider = makeProvider(rpc, Number(receipt.chainId ?? 31337));
const r = await verifyReceipt(receipt, provider, reveal);
console.log(`${receipt.reportRef ?? "receipt"} checked against ${rpc}: ${r.verdict.toUpperCase()}`);
if (r.missing.length) console.log(`  missing fields: ${r.missing.join(", ")}`);
for (const c of r.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.check.padEnd(18)} ${c.detail}`);
if (r.reveal) console.log(`  reveal: ${r.reveal.outcome}`);
provider.destroy();
process.exit(r.verdict === "valid" ? 0 : 1);
