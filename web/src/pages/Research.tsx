import { useEffect, useState } from "react";
import { api, ApiError } from "../api.ts";
import { ErrorNotice, Field, Loading, Notice, PageHead, Sheet, fmtTime } from "../ui.tsx";

interface Stats {
  n: number;
  median: number;
  p95: number | null;
  mean: number;
  min: number;
  max: number;
}
interface StoreResult {
  id: string;
  name: string;
  description: string;
  insert: Stats;
  verify: Stats;
  throughputPerSec: number;
  storage: { offChainBytesPerRecord: number; onChainBytesPerRecord: number | null; calldataBytesPerRecord: number | null; method: string };
  gas: { meanPerRecord: number; perType: Record<string, { n: number; median: number }>; deployment: number } | null;
}
interface ScenarioResult {
  trials: number;
  prevented: number;
  detected: number;
  undetected: number;
  protectedRate: number;
  note: string;
}
interface Bench {
  generatedAt: string;
  config: { devices: number; eventsPerDevice: number; seed: number; trials: number; totalRecords: number; node: string; platform: string; arch: string; cpu: string };
  stores: StoreResult[];
  scenarios: { id: string; title: string; attacker: string; kind: string; results: Record<string, ScenarioResult> }[];
  notes: string[];
}
interface Status {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  params: { devices: number; events: number; seed: number } | null;
  log: string;
}

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : v.toFixed(0));

function outcome(r: ScenarioResult | undefined, kind: string) {
  if (!r) return <span className="muted">n/a</span>;
  const label = kind === "preservation" ? (r.undetected === 0 ? "preserved" : r.prevented === 0 ? "lost" : "partly lost") : r.undetected === 0 ? (r.prevented === r.trials ? "prevented" : r.detected === r.trials ? "detected" : "prevented/detected") : r.undetected === r.trials ? "undetected" : "partial";
  const cls = r.undetected === 0 ? (r.prevented === r.trials ? "out-prevented" : "out-detected") : "out-undetected";
  return (
    <span className={cls} title={r.note}>
      {label} {Math.round(r.protectedRate * 100)}%
      <div className="small muted" style={{ fontWeight: 400 }}>
        {kind === "preservation" ? `${r.prevented} preserved / ${r.trials}` : `${r.prevented}P · ${r.detected}D · ${r.undetected}U / ${r.trials}`}
      </div>
    </span>
  );
}

export function Research() {
  const [data, setData] = useState<Bench | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState({ devices: "10", events: "8", seed: "42" });
  const [err, setErr] = useState<unknown>(null);

  const loadLatest = () =>
    api.get<Bench>("/api/benchmark/latest").then(
      (d) => {
        setData(d);
        setLoadErr(null);
      },
      (e) => setLoadErr(e),
    );
  useEffect(() => {
    loadLatest();
    api.get<Status>("/api/benchmark/status").then(setStatus, () => undefined);
  }, []);
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(async () => {
      const s = await api.get<Status>("/api/benchmark/status").catch(() => null);
      if (s) {
        setStatus(s);
        if (!s.running) loadLatest();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [status?.running]);

  async function run() {
    setErr(null);
    try {
      setStatus(await api.post<Status>("/api/benchmark/run", { devices: Number(form.devices), events: Number(form.events), seed: Number(form.seed) }));
    } catch (e) {
      setErr(e);
    }
  }
  const storeIds = data?.stores.map((s) => s.id) ?? [];

  return (
    <>
      <PageHead
        kicker="Section 06 · Research evaluation"
        title="Blockchain vs. centralised recordkeeping"
        lede="A reproducible benchmark over synthetic device histories. Latency, storage and gas are direct measurements on this machine; the attack matrix reports the outcomes of simulated attacks executed against each store."
      />
      <div className="grid-2">
        <Sheet tab="Run benchmark">
          <ErrorNotice error={err} />
          <div className="form-row">
            <Field label="Devices" htmlFor="b-dev">
              <input id="b-dev" inputMode="numeric" value={form.devices} onChange={(e) => setForm({ ...form, devices: e.target.value })} />
            </Field>
            <Field label="Events per device" htmlFor="b-ev">
              <input id="b-ev" inputMode="numeric" value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} />
            </Field>
            <Field label="Random seed" htmlFor="b-seed">
              <input id="b-seed" inputMode="numeric" value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} />
            </Field>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={run} disabled={status?.running}>
              {status?.running ? "Benchmark running…" : "Run benchmark"}
            </button>
            <span className="small muted">Starts its own throw-away local chain; the demo ledger is not touched.</span>
          </div>
          {status && (status.running || status.log) && (
            <div style={{ marginTop: 12 }}>
              <div className="small mono" style={{ marginBottom: 4 }}>
                {status.running ? `running since ${fmtTime(status.startedAt)}` : `finished ${fmtTime(status.finishedAt)} · exit ${status.exitCode}`}
              </div>
              <pre className="log" aria-live="polite">
                {status.log.split("\n").slice(-14).join("\n")}
              </pre>
            </div>
          )}
        </Sheet>
        <Sheet tab="Reading the results">
          <dl className="kv small">
            <dt>Measured</dt>
            <dd>Insert / verify latency, throughput, storage and gas — wall-clock on this laptop, single client, sequential writes.</dd>
            <dt>Simulated</dt>
            <dd>Attack outcomes: each attack is executed and the store’s own verifier is then run. P = prevented, D = detected afterwards, U = undetected.</dd>
            <dt>Caveat</dt>
            <dd>One machine, automining local chain (no consensus delay). Descriptive statistics only — no significance testing.</dd>
          </dl>
        </Sheet>
      </div>
      {!data && !loadErr && <Loading />}
      {loadErr instanceof ApiError && loadErr.status === 404 && <Notice kind="warn">No benchmark results yet — run one above (takes well under a minute with the defaults).</Notice>}
      {data && (
        <>
          <p className="small muted">
            Latest run {fmtTime(data.generatedAt)} · {data.config.devices} devices × {data.config.eventsPerDevice} events (= {data.config.totalRecords} records per store) · seed {data.config.seed} · {data.config.trials} trials per attack · Node{" "}
            {data.config.node} on {data.config.platform}/{data.config.arch} ({data.config.cpu}) · <a href="/api/benchmark/report">Markdown report</a> · <a href="/api/benchmark/latest">raw JSON</a>
          </p>
          <Sheet tab="Performance and storage (measured)" flush>
            <div className="table-scroll">
              <table className="ledger perf">
                <thead>
                  <tr>
                    <th scope="col">Store</th>
                    <th scope="col" className="num">Insert median ms</th>
                    <th scope="col" className="num">Insert p95 ms</th>
                    <th scope="col" className="num">Throughput rec/s</th>
                    <th scope="col" className="num">Verify history median ms</th>
                    <th scope="col" className="num">Verify p95 ms</th>
                    <th scope="col" className="num">Off-chain B/rec</th>
                    <th scope="col" className="num">On-chain B/rec</th>
                    <th scope="col" className="num">Gas/rec</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stores.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <b>{s.name}</b>
                        <div className="small muted">{s.description}</div>
                      </td>
                      <td className="num">{ms(s.insert.median)}</td>
                      <td className="num">{ms(s.insert.p95)}</td>
                      <td className="num">{s.throughputPerSec.toFixed(0)}</td>
                      <td className="num">{ms(s.verify.median)}</td>
                      <td className="num">{ms(s.verify.p95)}</td>
                      <td className="num">{s.storage.offChainBytesPerRecord.toFixed(0)}</td>
                      <td className="num">{s.storage.onChainBytesPerRecord === null ? "—" : s.storage.onChainBytesPerRecord.toFixed(0)}</td>
                      <td className="num">{s.gas ? s.gas.meanPerRecord.toFixed(0) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sheet>
          <Sheet tab="Attack and integrity scenarios (simulated attacks, real executions)" flush>
            <div className="table-scroll">
              <table className="ledger matrix">
                <thead>
                  <tr>
                    <th scope="col">Scenario</th>
                    {data.stores.map((s) => (
                      <th key={s.id} scope="col">
                        {s.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.scenarios.map((sc) => (
                    <tr key={sc.id}>
                      <td>
                        <b>
                          {sc.id} · {sc.title}
                        </b>
                        <div className="small muted">{sc.attacker}</div>
                      </td>
                      {storeIds.map((id) => (
                        <td key={id} className="outcome">
                          {outcome(sc.results[id], sc.kind)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sheet>
          {data.stores.find((s) => s.gas) && (
            <Sheet tab="Gas by record type (measured from receipts)">
              <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Record type</th>
                    <th scope="col" className="num">n</th>
                    <th scope="col" className="num">Median gas</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.stores.find((s) => s.gas)!.gas!.perType).map(([t, g]) => (
                    <tr key={t}>
                      <td>{t}</td>
                      <td className="num">{g.n}</td>
                      <td className="num">{g.median}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Sheet>
          )}
          <Sheet tab="Notes and limitations">
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {data.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Sheet>
        </>
      )}
    </>
  );
}
