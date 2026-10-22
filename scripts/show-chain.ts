// Print what is actually stored on the local blockchain, read straight from the node.
// Usage:
//   npm run chain           every block and transaction so far, then each device's on-chain records
//   npm run chain -- --watch   also follow new blocks live (Ctrl+C to stop)
import { Contract, type Log } from "ethers";
import { loadArtifact, makeProvider } from "../server/chain.ts";
import { loadConfig, readDeployment } from "../server/config.ts";
import { IDENTITIES, RECORD_TYPES, OUTCOMES, ROLE } from "../server/domain.ts";
import { walletFor } from "../server/chain.ts";
import { NO_REF } from "../server/ledger-hash.ts";

const cfg = loadConfig();
const dep = readDeployment(cfg.deploymentPath);
const provider = makeProvider(dep.rpcUrl, dep.chainId);
const { abi } = loadArtifact();
const contract = new Contract(dep.address, abi, provider);
const names = new Map(IDENTITIES.map((i) => [walletFor(i).address.toLowerCase(), i.label]));
const who = (a: string | null) => (a ? (names.get(a.toLowerCase()) ?? a) : "-");
const short = (h: string) => `${h.slice(0, 10)}...${h.slice(-6)}`;
const time = (ts: number) => new Date(ts * 1000).toLocaleString("en-IN", { hour12: false });

// device key -> public id, from the off-chain store's seed summary and database if present
const deviceNames = new Map<string, string>();
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
  for (const r of db.prepare("SELECT public_id, device_key, brand, model FROM devices").all() as any[]) deviceNames.set(r.device_key, `${r.public_id} (${r.brand} ${r.model})`);
  db.close();
} catch {
  /* database not available: keys are shown raw */
}

async function printBlock(n: number) {
  const block = await provider.getBlock(n, true);
  if (!block) return;
  for (const tx of block.prefetchedTransactions) {
    const receipt = await provider.getTransactionReceipt(tx.hash);
    let call = tx.to ? "transaction" : "contract deployment";
    try {
      const parsed = contract.interface.parseTransaction({ data: tx.data });
      if (parsed) call = parsed.name;
    } catch {
      /* not a PatchLedger call */
    }
    console.log(`Block #${block.number}  ${time(block.timestamp)}  ${call}  by ${who(tx.from)}  gas ${receipt?.gasUsed}  ${receipt?.status === 1 ? "OK" : "REVERTED"}`);
    console.log(`  tx ${tx.hash}`);
    for (const log of (receipt?.logs ?? []) as Log[]) {
      try {
        const ev = contract.interface.parseLog(log);
        if (ev?.name === "RecordAppended") {
          const ref = Number(ev.args.refSeq);
          console.log(
            `  -> record #${ev.args.seq} ${RECORD_TYPES[Number(ev.args.recordType)]}${ref === NO_REF ? "" : ` (refers to #${ref})`}` +
              `${Number(ev.args.outcome) ? ` outcome ${OUTCOMES[Number(ev.args.outcome)]}` : ""} for ${deviceNames.get(ev.args.deviceKey) ?? short(ev.args.deviceKey)}`,
          );
          console.log(`     recordHash ${ev.args.recordHash}`);
          console.log(`     prevHash   ${ev.args.prevHash}`);
        } else if (ev?.name === "DisputeOpened") console.log(`  -> dispute opened against record #${ev.args.targetSeq}`);
        else if (ev?.name === "DisputeResolved") console.log(`  -> dispute #${ev.args.challengeSeq} resolved: ${OUTCOMES[Number(ev.args.outcome)]}`);
        else if (ev?.name === "RoleGranted") console.log(`  -> role ${Object.entries(ROLE).find(([, v]) => v === Number(ev.args.role))?.[0] ?? ev.args.role} granted to ${who(ev.args.account)}`);
      } catch {
        /* other contract's log */
      }
    }
  }
}

console.log(`PatchLedger contract ${dep.address} on ${dep.rpcUrl} (chain ${dep.chainId}, local Hardhat node)\n`);
console.log("== Blocks and transactions ==");
let last = await provider.getBlockNumber();
for (let n = 1; n <= last; n++) await printBlock(n);

console.log("\n== On-chain records per device (contract.getRecords) ==");
const keys = deviceNames.size ? [...deviceNames.keys()] : [];
if (!keys.length) console.log("(no off-chain database found to list device keys)");
for (const key of keys) {
  const recs = (await contract.getRecords(key)) as any[];
  const [ok] = await contract.verifyChain(key);
  console.log(`\n${deviceNames.get(key)}  key ${short(key)}  ${recs.length} records  verifyChain=${ok}  open disputes=${await contract.openDisputeCount(key)}`);
  recs.forEach((r, i) => {
    const ref = Number(r.refSeq);
    console.log(
      `  #${String(i).padStart(3, "0")} ${RECORD_TYPES[Number(r.recordType)].padEnd(22)} ${who(r.actor).padEnd(24)} ${time(Number(r.timestamp))}  hash ${short(r.recordHash)}  prev ${short(r.prevHash)}${ref === NO_REF ? "" : `  ref #${ref}`}`,
    );
  });
}

if (process.argv.includes("--watch")) {
  console.log("\n== Watching for new blocks (Ctrl+C to stop) ==");
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await provider.getBlockNumber().catch(() => last);
    for (let n = last + 1; n <= now; n++) await printBlock(n);
    last = now;
  }
} else {
  provider.destroy();
}
