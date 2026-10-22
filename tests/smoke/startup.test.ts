// Startup smoke test: runs ./run.sh exactly as a user would (isolated data dir and ports),
// checks every service and seeded page, then interrupts it and checks clean shutdown.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { freePort } from "../../scripts/lib/chainproc.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
let proc: ChildProcess | undefined;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchledger-smoke-"));

async function portOpen(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

describe("./run.sh startup", () => {
  after(() => {
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("launches chain, contract, seed data, API and frontend, then shuts down cleanly", { timeout: 180_000 }, async () => {
    const appPort = await freePort();
    const chainPort = await freePort();
    proc = spawn("./run.sh", ["--no-open"], {
      cwd: ROOT,
      env: { ...process.env, PL_DATA_DIR: dataDir, PL_PORT: String(appPort), PL_CHAIN_PORT: String(chainPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout!.on("data", (d) => (out += d));
    proc.stderr!.on("data", (d) => (out += d));
    const started = Date.now();
    while (!out.includes("PatchLedger is running")) {
      assert.ok(proc.exitCode === null, `run.sh exited early:\n${out}`);
      assert.ok(Date.now() - started < 170_000, `timeout waiting for startup:\n${out}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const base = `http://127.0.0.1:${appPort}`;

    // backend ↔ chain
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.chain.rpcUrl, `http://127.0.0.1:${chainPort}`);
    // frontend served and its bundle loads
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /<div id="root"><\/div>/);
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1];
    assert.equal((await fetch(base + asset)).status, 200);
    // seeded devices: API + SPA routes + public verify
    const summary = JSON.parse(fs.readFileSync(path.join(dataDir, "seed-summary.json"), "utf8"));
    for (const id of Object.values(summary.devices) as string[]) {
      const p = await fetch(`${base}/api/devices/${id}`);
      assert.equal(p.status, 200);
      assert.equal((await fetch(`${base}/devices/${id}`)).status, 200);
      const pub = await (await fetch(`${base}/api/public/devices/${id}`)).json();
      assert.equal(pub.integrity.ok, true, `${id} integrity`);
    }
    const dash = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(dash.totals.devices, 4);
    assert.equal(dash.totals.openDisputes, 1);

    // clean shutdown on Ctrl+C
    const exited = new Promise((r) => proc!.once("exit", r));
    proc.kill("SIGINT");
    await exited;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await portOpen(appPort), false, "server port released");
    assert.equal(await portOpen(chainPort), false, "chain port released");
    assert.match(out, /stopped\./);
    assert.doesNotMatch(out, /stopped unexpectedly/, "no spurious crash message on Ctrl+C");
    assert.match(out, /Contract      0x[0-9a-fA-F]{40}/, "status block names the deployed contract");
  });
});
