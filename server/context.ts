// Opens everything the server needs from an initialised data directory (see scripts/bootstrap.ts).
import fs from "node:fs";
import { Ledger } from "./chain.ts";
import { loadConfig, readDeployment, type AppConfig } from "./config.ts";
import { Store } from "./db.ts";
import { Journal } from "./journal.ts";
import { Keyring } from "./keys.ts";
import { Sessions } from "./session.ts";
import { VulnSealService } from "./service.ts";
import { Vault } from "./vault.ts";

export function openContext(cfg: AppConfig = loadConfig(), rpcOverride?: string) {
  const dep = readDeployment(cfg.deploymentPath);
  if (!fs.existsSync(cfg.keyringPath)) throw new Error(`Demo keyring missing at ${cfg.keyringPath}. Start with ./run.sh.`);
  const vault = Vault.open(cfg.keyDir);
  const keyring = Keyring.load(cfg.keyringPath, vault);
  const journal = new Journal(cfg.journalPath);
  const store = new Store(cfg.dbPath);
  const bound = store.getMeta("contract");
  if (bound && bound.toLowerCase() !== dep.address.toLowerCase()) {
    throw new Error(`Database belongs to contract ${bound} but the deployment is ${dep.address}. Run ./run.sh --reset to start over.`);
  }
  const ledger = new Ledger({ rpcUrl: rpcOverride ?? dep.rpcUrl, address: dep.address, keyring, journal, chainId: dep.chainId });
  const svc = new VulnSealService({ store, vault, ledger, keyring, evidenceDir: cfg.evidenceDir });
  return { cfg, dep, store, vault, keyring, journal, ledger, svc, sessions: Sessions.open(cfg.keyDir) };
}
