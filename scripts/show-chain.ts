// Print what is actually on the local blockchain, read straight from the node.
//   npm run ledger                every block and VulnSeal log entry so far
//   npm run ledger -- --watch     then follow new blocks live (Ctrl+C to stop)
import { Contract, type Log } from "ethers";
import { loadArtifact, makeProvider } from "../server/chain.ts";
import { loadConfig, readDeployment } from "../server/config.ts";
import { LOG_KINDS } from "../server/domain.ts";
import { Keyring, faucetWallet } from "../server/keys.ts";
import { Vault } from "../server/vault.ts";

const cfg = loadConfig();
const dep = readDeployment(cfg.deploymentPath);
const provider = makeProvider(dep.rpcUrl, dep.chainId);
const c = new Contract(dep.address, loadArtifact().abi, provider);
const keyring = Keyring.load(cfg.keyringPath, Vault.open(cfg.keyDir));
const faucet = faucetWallet().address.toLowerCase();
const who = (a: string | null) => (!a ? "-" : a.toLowerCase() === faucet ? "faucet (Hardhat dev account #0)" : (keyring.idOf(a) ?? `${a.slice(0, 10)}…`));
const time = (ts: number) => new Date(ts * 1000).toLocaleString("en-IN", { hour12: false });

async function printBlock(n: number) {
  const block = await provider.getBlock(n, true);
  if (!block) return;
  if (!block.prefetchedTransactions.length) {
    console.log(`Block #${block.number}  ${time(block.timestamp)}  (empty: clock sync)`);
    return;
  }
  for (const tx of block.prefetchedTransactions) {
    const receipt = await provider.getTransactionReceipt(tx.hash);
    let call = tx.to ? (tx.data === "0x" ? "transfer (gas funding)" : "transaction") : "contract deployment";
    try {
      const parsed = c.interface.parseTransaction({ data: tx.data });
      if (parsed) call = parsed.name;
    } catch {
      /* not a VulnSeal call */
    }
    console.log(`Block #${block.number}  ${time(block.timestamp)}  ${call}  by ${who(tx.from)}  gas ${receipt?.gasUsed}  ${receipt?.status === 1 ? "OK" : "REVERTED"}`);
    for (const log of (receipt?.logs ?? []) as Log[]) {
      try {
        const ev = c.interface.parseLog(log);
        if (ev?.name === "LogAppended") console.log(`  log #${ev.args.seq} ${LOG_KINDS[Number(ev.args.kind)]} (subject ${ev.args.subject})  entry ${String(ev.args.entryHash).slice(0, 14)}…  prev ${String(ev.args.prevHash).slice(0, 14)}…`);
        else if (ev?.name === "CommitmentAnchored") console.log(`  -> commitment #${ev.args.cid} ${ev.args.commitment} for program ${ev.args.programId}`);
        else if (ev?.name === "DisputeFinal") console.log(`  -> dispute #${ev.args.did} final: decision ${ev.args.decision}, reason ${ev.args.reasonCode}${ev.args.reversed ? " (appeal reversed it)" : ""}`);
      } catch {
        /* other contract */
      }
    }
  }
}

console.log(`VulnSeal contract ${dep.address} on ${dep.rpcUrl} (chain ${dep.chainId}, single local node)\n`);
let last = await provider.getBlockNumber();
for (let n = 1; n <= last; n++) await printBlock(n);
console.log(`\nlog head ${await c.logHead()} after ${await c.logCount()} entries; ${await c.commitmentCount()} commitments, ${await c.disputeCount()} disputes`);
if (process.argv.includes("--watch")) {
  console.log("\n== watching for new blocks (Ctrl+C to stop) ==");
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await provider.getBlockNumber().catch(() => last);
    for (let n = last + 1; n <= now; n++) await printBlock(n);
    last = now;
  }
} else provider.destroy();
