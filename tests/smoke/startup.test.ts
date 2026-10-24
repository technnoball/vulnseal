// Startup smoke test: runs ./run.sh as a user would (isolated data dir and ports), checks
// every service, creates a report, stops with Ctrl+C, starts again and checks that the
// ledger was restored from its journal with the data intact.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { freePort } from "../../scripts/lib/chainproc.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vulnseal-smoke-"));
let proc: ChildProcess | undefined;

async function portOpen(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function start(appPort: number, chainPort: number) {
  proc = spawn("./run.sh", ["--no-open"], { cwd: ROOT, env: { ...process.env, VS_DATA_DIR: dataDir, VS_PORT: String(appPort), VS_CHAIN_PORT: String(chainPort) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const t0 = Date.now();
  while (!out.includes("VulnSeal is running")) {
    assert.ok(proc.exitCode === null, `run.sh exited early:\n${out}`);
    assert.ok(Date.now() - t0 < 170_000, `timeout:\n${out}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { output: () => out, proc };
}

async function stop(p: ChildProcess, out: () => string, ports: number[]) {
  const exited = new Promise((r) => p.once("exit", r));
  p.kill("SIGINT");
  await exited;
  await new Promise((r) => setTimeout(r, 500));
  for (const port of ports) assert.equal(await portOpen(port), false, `port ${port} released`);
  assert.match(out(), /stopped\./);
  assert.doesNotMatch(out(), /stopped unexpectedly/);
}

async function signIn(base: string, id: string) {
  const r = await fetch(`${base}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identityId: id }) });
  return { Cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("./run.sh", () => {
  after(() => {
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts every service, then restores the same ledger after a restart", { timeout: 300_000 }, async () => {
    const appPort = await freePort();
    const chainPort = await freePort();
    const base = `http://127.0.0.1:${appPort}`;

    // ---- first start: fresh, seeded ledger
    let run = await start(appPort, chainPort);
    assert.match(run.output(), /initialising a new consortium ledger/);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.chain.rpcUrl, `http://127.0.0.1:${chainPort}`);
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /<div id="root"><\/div>/);
    assert.equal((await fetch(base + /src="(\/assets\/[^"]+\.js)"/.exec(html)![1])).status, 200);
    assert.equal((await fetch(`${base}/reports/1`)).status, 200, "SPA route for a seeded report");
    const dash1 = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(dash1.totals.commitments, 10);
    assert.equal(dash1.totals.completedArbitrations, 1);
    const basalt = await signIn(base, "basalt");
    const created = await (
      await fetch(`${base}/api/reports`, {
        method: "POST",
        headers: { ...basalt, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: 2, title: "Smoke-test synthetic report", description: "SYNTHETIC.", impact: "None.", reproduction: "None.", scope: "smoke.example", severity: "low" }),
      })
    ).json();
    assert.ok(created.cid > 10, JSON.stringify(created));
    await stop(run.proc, run.output, [appPort, chainPort]);

    // ---- second start: the ledger is replayed from the journal
    run = await start(appPort, chainPort);
    assert.match(run.output(), /restoring the chain from \d+ journaled entries/);
    assert.match(run.output(), /matches the off-chain history/);
    const dash2 = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(dash2.totals.commitments, 11);
    assert.equal(dash2.chain.logHead, (await (await fetch(`${base}/api/dashboard`)).json()).chain.logHead);
    const again = await signIn(base, "basalt");
    const view = await (await fetch(`${base}/api/reports/${created.cid}`, { headers: again })).json();
    assert.equal(view.commitment, created.commitment);
    assert.equal(view.content.title, "Smoke-test synthetic report");
    const auditor = await signIn(base, "auditor");
    const audit = await (await fetch(`${base}/api/audit/report`, { headers: auditor })).json();
    assert.equal(audit.ok, true, JSON.stringify(audit.findings));
    await stop(run.proc, run.output, [appPort, chainPort]);
  });
});
