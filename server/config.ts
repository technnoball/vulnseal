// Runtime configuration. Everything binds to 127.0.0.1 unless told otherwise.
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

export interface Deployment {
  address: string;
  chainId: number;
  rpcUrl: string;
  deployedAt: string;
  appealWindowSeconds: number;
  threshold: number;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  keyDir: string;
  evidenceDir: string;
  chainDir: string;
  journalPath: string;
  deploymentPath: string;
  keyringPath: string;
  webDist: string;
  resultsDir: string;
  demoLab: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const dataDir = path.resolve(ROOT, env.VS_DATA_DIR ?? "data");
  const chainDir = path.join(dataDir, "chain");
  const keyDir = path.join(dataDir, "keys");
  return {
    host: env.VS_HOST ?? "127.0.0.1",
    port: Number(env.VS_PORT ?? 4700),
    dataDir,
    dbPath: path.join(dataDir, "vulnseal.sqlite"),
    keyDir,
    evidenceDir: path.join(dataDir, "evidence"),
    chainDir,
    journalPath: path.join(chainDir, "journal.jsonl"),
    deploymentPath: path.join(chainDir, "deployment.json"),
    keyringPath: path.join(keyDir, "identities.sealed"),
    webDist: path.resolve(ROOT, env.VS_WEB_DIST ?? "web/dist"),
    resultsDir: path.resolve(ROOT, env.VS_RESULTS_DIR ?? "docs/results"),
    demoLab: (env.VS_DEMO_LAB ?? "1") !== "0",
  };
}

export function readDeployment(p: string): Deployment {
  if (!fs.existsSync(p)) throw new Error(`No deployment at ${p}. Start with ./run.sh.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeDeployment(p: string, d: Deployment) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
}
