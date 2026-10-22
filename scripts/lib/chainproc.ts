// Start and stop a local Hardhat development node bound to 127.0.0.1.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

export async function freePort(preferred?: number): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", reject);
      srv.listen(p, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : p;
        srv.close(() => resolve(port));
      });
    });
  if (preferred) {
    try {
      return await tryPort(preferred);
    } catch {
      /* fall through to an ephemeral port */
    }
  }
  return tryPort(0);
}

export async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`local chain did not respond at ${url} within ${timeoutMs} ms`);
}

export interface ChainProcess {
  url: string;
  port: number;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

export async function startChain(port?: number): Promise<ChainProcess> {
  const p = port ?? (await freePort());
  const bin = path.join(ROOT, "node_modules/.bin/hardhat");
  const proc = spawn(bin, ["node", "--config", "hardhat.config.cjs", "--hostname", "127.0.0.1", "--port", String(p)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d));
  const url = `http://127.0.0.1:${p}`;
  try {
    await waitForRpc(url);
  } catch (e) {
    proc.kill("SIGTERM");
    throw new Error(`${(e as Error).message}\n${stderr}`);
  }
  return {
    url,
    port: p,
    proc,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 3000).unref();
      }),
  };
}
