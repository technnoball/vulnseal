// Run the auditor's integrity check against the running deployment.
// Usage: node scripts/integrity-check.ts [--json]
import { openContext } from "../server/context.ts";
import { auditReport } from "../server/integrity.ts";

const ctx = openContext();
const r = await auditReport(ctx.svc);
if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
else {
  console.log(`VulnSeal integrity check - contract ${r.chain.contract}, ${r.counts.logEntries} log entries, head ${r.chain.logHead}`);
  console.log(`  checked ${r.counts.commitments} commitments, ${r.counts.reveals} reveals, ${r.counts.evidence} evidence files, ${r.counts.associations} associations, ${r.counts.disputes} disputes`);
  for (const f of r.findings) console.log(`  ${f.severity.toUpperCase().padEnd(7)} ${f.code} ${f.subject}: ${f.message}`);
  console.log(r.ok ? "  RESULT: consistent" : "  RESULT: INCONSISTENT");
}
ctx.store.close();
ctx.ledger.provider.destroy();
process.exit(r.ok ? 0 : 1);
