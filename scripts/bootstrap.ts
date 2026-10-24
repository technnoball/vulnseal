// Bring a freshly started local chain to the application's state.
//   fresh data dir  -> generate demo keys, deploy, register programs/participants, seed
//   existing data   -> replay the transaction journal and check the result matches
// Usage: node scripts/bootstrap.ts --rpc http://127.0.0.1:8545 [--reset] [--no-seed]
import fs from "node:fs";
import path from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { Ledger, deployVulnSeal, makeProvider, registerParticipants } from "../server/chain.ts";
import { loadConfig, readDeployment, writeDeployment } from "../server/config.ts";
import { Store } from "../server/db.ts";
import { PROGRAMS } from "../server/domain.ts";
import { Journal, replay, syncClock } from "../server/journal.ts";
import { Keyring } from "../server/keys.ts";
import { POLICY_TEXTS } from "../server/policies.ts";
import { VulnSealService } from "../server/service.ts";
import { Vault } from "../server/vault.ts";
import { seedDemo } from "./seed.ts";

export const CHAIN_INITIAL_DATE = "2020-01-01T00:00:00Z";
export const APPEAL_WINDOW_SECONDS = 3 * 24 * 3600;

const args = process.argv.slice(2);
const rpcUrl = args[args.indexOf("--rpc") + 1] ?? "http://127.0.0.1:8545";
const cfg = loadConfig();
const log = (m: string) => console.log(`[bootstrap] ${m}`);

function archiveDataDir(reason: string) {
  const stateFiles = [cfg.dbPath, cfg.journalPath, cfg.deploymentPath, cfg.keyringPath];
  if (!stateFiles.some((f) => fs.existsSync(f) && fs.statSync(f).size > 0)) return;
  const items = fs.readdirSync(cfg.dataDir).filter((f) => f !== "archive" && f !== "logs");
  const dest = path.join(cfg.dataDir, "archive", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of items) fs.renameSync(path.join(cfg.dataDir, f), path.join(dest, f));
  log(`${reason}: previous data moved to ${path.relative(process.cwd(), dest)}`);
}

if (args.includes("--reset")) archiveDataDir("reset requested");

const provider = makeProvider(rpcUrl);
const journal = new Journal(cfg.journalPath);
const haveState = fs.existsSync(cfg.deploymentPath) && fs.existsSync(cfg.keyringPath) && fs.existsSync(cfg.dbPath) && journal.entries().length > 0;
const nodeBlocks = await provider.getBlockNumber();

if (haveState) {
  const dep = readDeployment(cfg.deploymentPath);
  if (nodeBlocks === 0) {
    log(`restoring the chain from ${journal.entries().length} journaled entries…`);
    const r = await replay(provider, journal);
    await syncClock(provider, journal);
    log(`replayed ${r.transactions} transactions and ${r.emptyBlocks} empty blocks in ${r.ms} ms; transaction hashes and block numbers match the journal`);
  } else {
    log(`node already has ${nodeBlocks} blocks; not replaying`);
  }
  if ((await provider.getCode(dep.address)) === "0x") throw new Error(`no contract at ${dep.address} after restore`);
  writeDeployment(cfg.deploymentPath, { ...dep, rpcUrl });
  // the off-chain mirror must agree with the restored chain
  const vault = Vault.open(cfg.keyDir);
  const store = new Store(cfg.dbPath);
  const ledger = new Ledger({ rpcUrl, address: dep.address, keyring: Keyring.load(cfg.keyringPath, vault), chainId: dep.chainId });
  const head = await ledger.read<string>("logHead");
  const mirrorHead = store.get("SELECT entry_hash FROM chain_events ORDER BY seq DESC LIMIT 1")?.entry_hash;
  log(mirrorHead === head ? `log head ${head.slice(0, 14)}… matches the off-chain history` : `WARNING: off-chain history head ${String(mirrorHead).slice(0, 14)}… differs from the chain ${head.slice(0, 14)}… (run the audit)`);
  store.close();
  ledger.provider.destroy();
} else {
  if (nodeBlocks !== 0) throw new Error("the chain already has blocks but there is no saved state; start a fresh node");
  archiveDataDir("incomplete earlier state found");
  log("initialising a new consortium ledger");
  const vault = Vault.open(cfg.keyDir);
  const keyring = Keyring.generate();
  keyring.save(cfg.keyringPath, vault);
  const journal2 = new Journal(cfg.journalPath);
  await syncClock(provider, journal2);
  const { address, gasUsed } = await deployVulnSeal({ rpcUrl, keyring, journal: journal2, appealWindowSeconds: APPEAL_WINDOW_SECONDS, threshold: 2 });
  writeDeployment(cfg.deploymentPath, { address, chainId: 31337, rpcUrl, deployedAt: new Date().toISOString(), appealWindowSeconds: APPEAL_WINDOW_SECONDS, threshold: 2 });
  log(`VulnSeal deployed at ${address} (${gasUsed} gas)`);
  const ledger = new Ledger({ rpcUrl, address, keyring, journal: journal2 });
  const store = new Store(cfg.dbPath);
  store.setMeta("contract", address);
  for (const p of PROGRAMS) {
    const first = POLICY_TEXTS[p.id][0];
    const nameTag = keccak256(toUtf8Bytes(`vulnseal:program:${p.slug}`));
    await ledger.send("governor", "registerProgram", [nameTag, keccak256(toUtf8Bytes(first))]);
    store.run("INSERT INTO programs(id, slug, name, short, blurb, name_tag) VALUES (?, ?, ?, ?, ?, ?)", p.id, p.slug, p.name, p.short, p.blurb, nameTag);
    store.run("INSERT INTO policies(program_id, version, digest, body, published_at) VALUES (?, 1, ?, ?, ?)", p.id, keccak256(toUtf8Bytes(first)), first, new Date().toISOString());
  }
  await registerParticipants(ledger);
  // later policy versions are published by each program's own admin
  for (const p of PROGRAMS) {
    for (const [i, body] of POLICY_TEXTS[p.id].slice(1).entries()) {
      await ledger.send(`${p.slug}-admin`, "publishPolicy", [p.id, keccak256(toUtf8Bytes(body))]);
      store.run("INSERT INTO policies(program_id, version, digest, body, published_at) VALUES (?, ?, ?, ?, ?)", p.id, i + 2, keccak256(toUtf8Bytes(body)), body, new Date().toISOString());
    }
  }
  const svc = new VulnSealService({ store, vault, ledger, keyring, evidenceDir: cfg.evidenceDir });
  if (!args.includes("--no-seed")) {
    const ids = await seedDemo(svc);
    log(`seeded synthetic demo data: ${JSON.stringify(ids)}`);
  }
  const mirrored = await svc.syncLogMirror();
  log(`off-chain log mirror filled with ${mirrored} earlier entries`);
  store.close();
  ledger.provider.destroy();
}
provider.destroy();
