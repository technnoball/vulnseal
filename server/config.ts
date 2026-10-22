// Runtime configuration. Everything binds to 127.0.0.1 by default.
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

export interface Deployment {
  address: string;
  chainId: number;
  rpcUrl: string;
  deployedAt: string;
  blockNumber: number;
  gasUsed: number;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  evidenceDir: string;
  deploymentPath: string;
  webDist: string;
  resultsDir: string;
  demoLab: boolean;
  publicBaseUrl: string;
}

export function loadConfig(env = process.env): AppConfig {
  const dataDir = path.resolve(ROOT, env.PL_DATA_DIR ?? "data");
  const host = env.PL_HOST ?? "127.0.0.1";
  const port = Number(env.PL_PORT ?? 4600);
  return {
    host,
    port,
    dataDir,
    dbPath: path.join(dataDir, "patchledger.sqlite"),
    evidenceDir: path.join(dataDir, "evidence"),
    deploymentPath: path.join(dataDir, "deployment.json"),
    webDist: path.resolve(ROOT, env.PL_WEB_DIST ?? "web/dist"),
    resultsDir: path.resolve(ROOT, env.PL_RESULTS_DIR ?? "docs/results"),
    demoLab: (env.PL_DEMO_LAB ?? "1") !== "0",
    publicBaseUrl: env.PL_PUBLIC_URL ?? `http://${host}:${port}`,
  };
}

export function readDeployment(p: string): Deployment {
  if (!fs.existsSync(p)) throw new Error(`No deployment found at ${p}. Run ./run.sh (or npm run deploy) first.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
