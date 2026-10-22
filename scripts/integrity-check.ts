// Compare every off-chain record and evidence file with the commitments on-chain.
// Usage: node scripts/integrity-check.ts [PL-XXXX-XXXX] [--json]
import { openContext } from "../server/context.ts";

const args = process.argv.slice(2);
const ctx = openContext();
const reports = args.find((a) => a.startsWith("PL-"))
  ? [await ctx.svc.checkIntegrity(args.find((a) => a.startsWith("PL-"))!)]
  : (await ctx.svc.checkAll()).reports;
if (args.includes("--json")) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  console.log(`PatchLedger integrity check — contract ${ctx.ledger.address} on ${ctx.ledger.rpcUrl}\n`);
  for (const r of reports) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.publicId}  on-chain ${r.chain.onChainRecords} / off-chain ${r.chain.offChainRecords} records, ${r.evidenceChecked} evidence commitments`);
    for (const f of r.findings) console.log(`      ${f.severity.toUpperCase().padEnd(7)} ${f.code}${f.seq !== undefined ? ` #${f.seq}` : ""}: ${f.message}`);
  }
  console.log(`\n${reports.filter((r) => r.ok).length}/${reports.length} devices verified`);
}
ctx.store.close();
ctx.ledger.provider.destroy();
process.exit(reports.every((r) => r.ok) ? 0 : 1);
