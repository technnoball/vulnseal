// Deploy PatchLedger to the local chain and record the deployment.
// Usage: node scripts/deploy.ts --rpc http://127.0.0.1:8545 [--fresh]
//   --fresh archives the existing off-chain database and evidence first
//   (the Hardhat chain is in-memory, so a new chain needs a new database).
import fs from "node:fs";
import path from "node:path";
import { deployPatchLedger } from "../server/chain.ts";
import { loadConfig, type Deployment } from "../server/config.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const rpcUrl = arg("--rpc") ?? process.env.PL_RPC_URL ?? "http://127.0.0.1:8545";
const cfg = loadConfig();

if (args.includes("--fresh")) {
  const items = [cfg.dbPath, cfg.dbPath + "-wal", cfg.dbPath + "-shm", cfg.evidenceDir, cfg.deploymentPath, path.join(cfg.dataDir, "seed-summary.json")].filter((p) => fs.existsSync(p));
  if (items.length) {
    const archive = path.join(cfg.dataDir, "archive", new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(archive, { recursive: true });
    for (const p of items) fs.renameSync(p, path.join(archive, path.basename(p)));
    console.log(`[deploy] previous off-chain state archived to ${path.relative(process.cwd(), archive)}`);
  }
}

const { address, blockNumber, gasUsed } = await deployPatchLedger(rpcUrl);
const dep: Deployment = { address, chainId: 31337, rpcUrl, deployedAt: new Date().toISOString(), blockNumber, gasUsed };
fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.writeFileSync(cfg.deploymentPath, JSON.stringify(dep, null, 2));
console.log(`[deploy] PatchLedger deployed at ${address} (block ${blockNumber}, ${gasUsed} gas) on ${rpcUrl}`);
