// Test environment: a dedicated local chain, fresh deployment, temp data dir and the real Express app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "../../server/app.ts";
import { Ledger, deployPatchLedger } from "../../server/chain.ts";
import { loadConfig } from "../../server/config.ts";
import { Store } from "../../server/db.ts";
import { EvidenceVault } from "../../server/evidence.ts";
import { PatchLedgerService } from "../../server/service.ts";
import { startChain, type ChainProcess } from "../../scripts/lib/chainproc.ts";

export interface Env {
  base: string;
  svc: PatchLedgerService;
  dataDir: string;
  chain: ChainProcess;
  stop: () => Promise<void>;
}

export async function startEnv(): Promise<Env> {
  const chain = await startChain();
  const { address } = await deployPatchLedger(chain.url);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchledger-test-"));
  const cfg = { ...loadConfig({ PL_DATA_DIR: dataDir, PL_PORT: "0", PL_RESULTS_DIR: path.join(dataDir, "results") }), webDist: path.join(dataDir, "no-web") };
  const store = new Store(cfg.dbPath);
  const ledger = new Ledger(chain.url, address);
  const svc = new PatchLedgerService(store, ledger, new EvidenceVault(cfg.evidenceDir));
  const { app } = createApp(svc, cfg);
  const server: Server = await new Promise((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    svc,
    dataDir,
    chain,
    stop: async () => {
      await new Promise((r) => server.close(r));
      ledger.provider.destroy();
      store.close();
      await chain.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function client(base: string) {
  const call = async (method: string, url: string, actor?: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (actor) headers["X-Demo-Actor"] = actor;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  return {
    get: (url: string, actor?: string) => call("GET", url, actor),
    post: (url: string, actor: string | undefined, body: unknown = {}) => call("POST", url, actor, body),
    upload: async (url: string, actor: string, file: { name: string; type: string; data: Buffer }, fields: Record<string, string> = {}) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      fd.append("file", new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
      const res = await fetch(base + url, { method: "POST", headers: { "X-Demo-Actor": actor }, body: fd });
      return { status: res.status, body: await res.json() };
    },
  };
}
