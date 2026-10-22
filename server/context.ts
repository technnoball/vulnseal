// Wires config, store, ledger and service together.
import { Ledger } from "./chain.ts";
import { Store } from "./db.ts";
import { EvidenceVault } from "./evidence.ts";
import { loadConfig, readDeployment, type AppConfig } from "./config.ts";
import { PatchLedgerService } from "./service.ts";

export function openContext(cfg: AppConfig = loadConfig()) {
  const dep = readDeployment(cfg.deploymentPath);
  const store = new Store(cfg.dbPath);
  const bound = store.getMeta("contract");
  if (bound && bound.toLowerCase() !== dep.address.toLowerCase()) {
    throw new Error(
      `The database in ${cfg.dataDir} belongs to contract ${bound}, but the current deployment is ${dep.address}. ` +
        `The local chain is in-memory; restart with ./run.sh to reset and reseed.`,
    );
  }
  if (!bound) store.setMeta("contract", dep.address);
  const ledger = new Ledger(dep.rpcUrl, dep.address, dep.chainId);
  const svc = new PatchLedgerService(store, ledger, new EvidenceVault(cfg.evidenceDir));
  return { cfg, dep, store, ledger, svc };
}
