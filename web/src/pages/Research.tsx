import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { api, ApiError } from "../api.ts";
import { ErrorNotice, Field, Loading, Notice, PageHead, Sheet, fmtTime } from "../ui.tsx";

interface Stats {
  n: number;
  median: number;
  p95: number | null;
}
interface Design {
  id: string;
  name: string;
  description: string;
  metrics: {
    commit: Stats;
    receiptVerify: Stats;
    transition: Stats;
    throughputCommitsPerSec: number;
    storage: { bytesPerSubmission: number; bytesPerEvent: number; onChainBytesPerSubmission: number | null };
    gas: { meanPerSubmission: number; perOperation: Record<string, number> } | null;
  };
}
interface Result {
  trials: number;
  prevented: number;
  detected: number;
  undetected: number;
  passed?: number;
  note?: string;
}
interface Bench {
  generatedAt: string;
  config: Record<string, any>;
  designs: Design[];
  scenarios: { id: string; title: string; attacker: string; kind: string; results: Record<string, Result> }[];
  disclosure: { item: string; designs: Record<string, string> }[];
  notes: string[];
}

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : v.toFixed(0));

function Cell({ r, kind }: { r?: Result; kind: string }) {
  if (!r) return <span className="muted">n/a</span>;
  if (kind === "functional") {
    const ok = (r.passed ?? 0) === r.trials;
    return (
      <span className={ok ? "out-prevented" : "out-undetected"} title={r.note}>
        {ok ? "works" : "fails"} {r.passed}/{r.trials}
      </span>
    );
  }
  const protectedN = r.prevented + r.detected;
  const cls = r.undetected === 0 ? (r.prevented === r.trials ? "out-prevented" : "out-detected") : "out-undetected";
  const label = r.undetected === 0 ? (r.prevented === r.trials ? "prevented" : r.detected === r.trials ? "detected" : "prevented/detected") : r.undetected === r.trials ? "undetected" : "partial";
  return (
    <span className={cls} title={r.note}>
      {label} {Math.round((protectedN / r.trials) * 100)}%
      <div className="small muted" style={{ fontWeight: 400 }}>
        {r.prevented}P · {r.detected}D · {r.undetected}U
      </div>
    </span>
  );
}

export function Research() {
  const [data, setData] = useState<Bench | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [status, setStatus] = useState<any>(null);
  const [form, setForm] = useState({ reports: "40", seed: "42", trials: "10" });
  const [err, setErr] = useState<unknown>(null);
  const loadLatest = () => api.get<Bench>("/api/benchmark/latest").then((d) => (setData(d), setLoadErr(null)), setLoadErr);
  useEffect(() => {
    loadLatest();
    api.get("/api/benchmark/status").then(setStatus, () => undefined);
  }, []);
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(async () => {
      const s = await api.get<any>("/api/benchmark/status").catch(() => null);
      if (s) {
        setStatus(s);
        if (!s.running) loadLatest();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [status?.running]);
  const run = async () => {
    setErr(null);
    try {
      setStatus(await api.post("/api/benchmark/run", { reports: Number(form.reports), seed: Number(form.seed), trials: Number(form.trials) }));
    } catch (e) {
      setErr(e);
    }
  };
  const ids = data?.designs.map((d) => d.id) ?? [];
  return (
    <>
      <PageHead
        kicker="Research evaluation"
        title="Blockchain commitments vs. centralised alternatives"
        lede="A reproducible benchmark over synthetic reports. Latency, storage and gas are measured on this machine; the scenario matrix reports simulated attacks and functional checks that are actually executed against each design."
      />
      <div className="grid-2">
        <Sheet tab="Run the benchmark">
          <ErrorNotice error={err} />
          <div className="form-row">
            <Field label="Synthetic reports" htmlFor="b-r">
              <input id="b-r" inputMode="numeric" value={form.reports} onChange={(e) => setForm({ ...form, reports: e.target.value })} />
            </Field>
            <Field label="Random seed" htmlFor="b-s">
              <input id="b-s" inputMode="numeric" value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} />
            </Field>
            <Field label="Trials per scenario" htmlFor="b-t">
              <input id="b-t" inputMode="numeric" value={form.trials} onChange={(e) => setForm({ ...form, trials: e.target.value })} />
            </Field>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={run} disabled={status?.running}>
              <FlaskConical size={16} aria-hidden="true" /> {status?.running ? "Benchmark running…" : "Run benchmark"}
            </button>
            <span className="small muted">Uses its own throw-away chain; the demo ledger is untouched.</span>
          </div>
          {status && (status.running || status.log) && (
            <div style={{ marginTop: 12 }}>
              <div className="small mono">{status.running ? `running since ${fmtTime(status.startedAt)}` : `finished ${fmtTime(status.finishedAt)} · exit ${status.exitCode}`}</div>
              <pre className="log" aria-live="polite">
                {String(status.log).split("\n").slice(-14).join("\n")}
              </pre>
            </div>
          )}
        </Sheet>
        <Sheet tab="Reading the results">
          <dl className="kv small">
            <dt>Measured</dt>
            <dd>Commit, receipt-verification and status-transition latency; throughput; storage; gas.</dd>
            <dt>Simulated</dt>
            <dd>Attacks are executed, then each design's own verifier runs. P prevented, D detected afterwards, U undetected.</dd>
            <dt>Caveat</dt>
            <dd>One machine, one client, an automining single-node chain. Descriptive statistics only.</dd>
          </dl>
        </Sheet>
      </div>
      {!data && !loadErr && <Loading />}
      {loadErr instanceof ApiError && loadErr.status === 404 && <Notice kind="warn">No results yet — run the benchmark above.</Notice>}
      {data && (
        <>
          <p className="small muted">
            Run {fmtTime(data.generatedAt)} · {data.config.reports} reports · seed {data.config.seed} · {data.config.trials} trials · Node {data.config.node} · {data.config.cpu} ·{" "}
            <a href="/api/benchmark/report">Markdown report</a> · <a href="/api/benchmark/latest">JSON</a>
          </p>
          <Sheet tab="Performance and storage (measured)" flush>
            <div className="table-scroll">
              <table className="ledger perf">
                <thead>
                  <tr>
                    <th scope="col">Design</th>
                    <th scope="col" className="num">Commit median ms</th>
                    <th scope="col" className="num">Commit p95 ms</th>
                    <th scope="col" className="num">Commits/s</th>
                    <th scope="col" className="num">Receipt verify median ms</th>
                    <th scope="col" className="num">Status change median ms</th>
                    <th scope="col" className="num">Bytes / submission</th>
                    <th scope="col" className="num">Bytes / event</th>
                    <th scope="col" className="num">On-chain B / submission</th>
                    <th scope="col" className="num">Gas / submission</th>
                  </tr>
                </thead>
                <tbody>
                  {data.designs.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <b>{d.name}</b>
                        <div className="small muted">{d.description}</div>
                      </td>
                      <td className="num">{ms(d.metrics.commit.median)}</td>
                      <td className="num">{ms(d.metrics.commit.p95)}</td>
                      <td className="num">{d.metrics.throughputCommitsPerSec.toFixed(0)}</td>
                      <td className="num">{ms(d.metrics.receiptVerify.median)}</td>
                      <td className="num">{ms(d.metrics.transition.median)}</td>
                      <td className="num">{d.metrics.storage.bytesPerSubmission.toFixed(0)}</td>
                      <td className="num">{d.metrics.storage.bytesPerEvent.toFixed(0)}</td>
                      <td className="num">{d.metrics.storage.onChainBytesPerSubmission === null ? "—" : d.metrics.storage.onChainBytesPerSubmission.toFixed(0)}</td>
                      <td className="num">{d.metrics.gas ? d.metrics.gas.meanPerSubmission.toFixed(0) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sheet>
          <Sheet tab="Scenarios (simulated attacks and functional checks, actually executed)" flush>
            <div className="table-scroll">
              <table className="ledger matrix">
                <thead>
                  <tr>
                    <th scope="col">Scenario</th>
                    {data.designs.map((d) => (
                      <th scope="col" key={d.id}>
                        {d.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.scenarios.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <b>
                          {s.id} · {s.title}
                        </b>
                        <div className="small muted">{s.attacker}</div>
                      </td>
                      {ids.map((id) => (
                        <td key={id} className="outcome">
                          <Cell r={s.results[id]} kind={s.kind} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sheet>
          <Sheet tab="Who can see what (inspected from the stored data of each design)" flush>
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    {data.designs.map((d) => (
                      <th scope="col" key={d.id}>
                        {d.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.disclosure.map((x) => (
                    <tr key={x.item}>
                      <td className="small">{x.item}</td>
                      {ids.map((id) => (
                        <td key={id} className="small">
                          {x.designs[id]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sheet>
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
