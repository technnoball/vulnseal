// Test environment: a dedicated local chain, a fresh consortium, a temp data dir and the
// real Express app. client(identity) signs in with the demo session cookie.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "../../server/app.ts";
import { loadConfig } from "../../server/config.ts";
import { Store } from "../../server/db.ts";
import { Keyring } from "../../server/keys.ts";
import { VulnSealService } from "../../server/service.ts";
import { Sessions } from "../../server/session.ts";
import { Vault } from "../../server/vault.ts";
import { startChain, type ChainProcess } from "../../scripts/lib/chainproc.ts";
import { initConsortium } from "../../scripts/lib/consortium.ts";

export interface Env {
  base: string;
  svc: VulnSealService;
  dataDir: string;
  chain: ChainProcess;
  stop: () => Promise<void>;
}

export async function startEnv(appealWindowSeconds = 3600): Promise<Env> {
  const chain = await startChain();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vulnseal-test-"));
  const cfg = { ...loadConfig({ VS_DATA_DIR: dataDir, VS_PORT: "0", VS_RESULTS_DIR: path.join(dataDir, "results") }), webDist: path.join(dataDir, "no-web") };
  const store = new Store(cfg.dbPath);
  const vault = Vault.open(cfg.keyDir);
  const keyring = Keyring.generate();
  const { ledger } = await initConsortium({ rpcUrl: chain.url, keyring, store, appealWindowSeconds });
  const svc = new VulnSealService({ store, vault, ledger, keyring, evidenceDir: cfg.evidenceDir });
  await svc.syncLogMirror();
  const { app } = createApp(svc, Sessions.open(cfg.keyDir), cfg);
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

export interface Res {
  status: number;
  body: any;
  headers: Headers;
}

/** An HTTP client signed in as a demo identity (or anonymous when identity is undefined). */
export async function client(base: string, identity?: string) {
  let cookie = "";
  if (identity) {
    const r = await fetch(`${base}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identityId: identity }) });
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    if (!cookie) throw new Error(`sign-in as ${identity} failed`);
  }
  const call = async (method: string, url: string, body?: unknown): Promise<Res> => {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, body: unknown = {}) => call("POST", url, body),
    raw: (url: string) => fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} }),
    upload: async (url: string, file: { name: string; type: string; data: Buffer }) => {
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
      const res = await fetch(base + url, { method: "POST", headers: cookie ? { Cookie: cookie } : {}, body: fd });
      return { status: res.status, body: await res.json() };
    },
  };
}

export const REPORT = {
  title: "Synthetic test finding: export ignores tenant filter",
  description: "SYNTHETIC TEST. The fictional export endpoint returns rows of other tenants.",
  impact: "Fictional cross-tenant exposure.",
  reproduction: "1. Open the fictional export. 2. Leave the filter empty.",
  scope: "test.ashgrove.example (fictional)",
  severity: "high",
};
