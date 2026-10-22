import { useEffect, useState } from "react";
import { api, type DeviceSummary, type IntegrityReport, type Passport } from "../api.ts";
import { useIdentity } from "../identity.tsx";
import { Link } from "../router.tsx";
import { ErrorNotice, Field, Loading, Notice, PageHead, Sheet, fmtTime, pad, useLoad } from "../ui.tsx";
import { IntegrityPanel } from "./Passport.tsx";

interface ChainAttempts {
  actor: string;
  attempts: { attempt: string; rejected: boolean; error: string | null; contractError?: string }[];
  mutatingFunctions: string[];
  recordUnchanged: boolean;
  recordCountBefore: number;
  recordCountAfter: number;
}

export function Audit() {
  const { meta, actor } = useIdentity();
  const devices = useLoad(() => api.get<DeviceSummary[]>("/api/devices"), []);
  const [all, setAll] = useState<{ ok: boolean; checkedAt: string; reports: IntegrityReport[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<unknown>(null);

  async function checkAll() {
    setBusy("all");
    setErr(null);
    try {
      setAll(await api.get("/api/integrity"));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <PageHead
        kicker="Section 05 · Audit & export"
        title="Integrity checker and export"
        lede="The checker recomputes every payload digest and record hash and compares the off-chain store and evidence files with what the contract holds. Exports can be verified without this server."
        actions={
          <button className="btn primary" onClick={checkAll} disabled={busy === "all"}>
            {busy === "all" ? "Checking all devices…" : "Check all devices"}
          </button>
        }
      />
      <ErrorNotice error={err || devices.error} />
      {devices.loading && !devices.data && <Loading />}
      {devices.data && (
        <Sheet tab="Devices · integrity and export" flush aside={all ? `checked ${fmtTime(all.checkedAt)}` : "not yet checked"}>
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Integrity</th>
                  <th scope="col" className="num">On-chain / off-chain</th>
                  <th scope="col" className="num">Errors</th>
                  <th scope="col" className="num">Warnings</th>
                  <th scope="col">Export</th>
                </tr>
              </thead>
              <tbody>
                {devices.data.map((d) => {
                  const r = all?.reports.find((x) => x.publicId === d.publicId);
                  return (
                    <tr key={d.publicId}>
                      <td>
                        <Link to={`/devices/${d.publicId}`}>
                          {d.brand} {d.model}
                        </Link>
                        <div className="mono small muted">{d.publicId}</div>
                      </td>
                      <td>{r ? <span className={`mark ${r.ok ? "ok" : "bad"}`}>{r.ok ? "verified" : "failed"}</span> : <span className="muted small">—</span>}</td>
                      <td className="num">{r ? `${r.chain.onChainRecords} / ${r.chain.offChainRecords}` : "—"}</td>
                      <td className="num">{r ? r.findings.filter((f) => f.severity === "error").length : "—"}</td>
                      <td className="num">{r ? r.findings.filter((f) => f.severity === "warning").length : "—"}</td>
                      <td className="nowrap">
                        <a className="btn quiet" href={`/api/devices/${d.publicId}/export`} download>
                          JSON
                        </a>{" "}
                        <a className="btn quiet" href={`/api/devices/${d.publicId}/report`} download>
                          Report
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {all && all.reports.some((r) => r.findings.length) && (
            <div style={{ padding: 16 }}>
              {all.reports
                .filter((r) => r.findings.length)
                .map((r) => (
                  <div key={r.publicId} style={{ marginBottom: 16 }}>
                    <h3 className="mono" style={{ marginBottom: 8 }}>
                      {r.publicId}
                    </h3>
                    <IntegrityPanel report={r} />
                  </div>
                ))}
            </div>
          )}
        </Sheet>
      )}
      <Sheet tab="Independent re-verification">
        <p className="small">
          The exported JSON contains every canonical payload, record hash, previous hash, actor and evidence digest. Re-verify it without trusting this server (optionally comparing with the live chain):
        </p>
        <pre className="log">npm run verify-export -- ~/Downloads/patchledger-PL-XXXX-XXXX-history.json --rpc http://127.0.0.1:8545</pre>
      </Sheet>
      {meta?.demoLab && devices.data && <TamperLab devices={devices.data} actorLabel={actor?.label ?? ""} />}
    </>
  );
}

function TamperLab({ devices, actorLabel }: { devices: DeviceSummary[]; actorLabel: string }) {
  const [publicId, setPublicId] = useState(devices[0]?.publicId ?? "");
  const [seq, setSeq] = useState(1);
  const [evidenceId, setEvidenceId] = useState("");
  const [passport, setPassport] = useState<Passport | null>(null);
  const [result, setResult] = useState<{ action: string; integrity: IntegrityReport | null; chain?: ChainAttempts; note?: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [backups, setBackups] = useState<{ id: number; kind: string; target: string }[]>([]);

  const loadState = () => api.get<typeof backups>("/api/lab/state").then(setBackups, () => undefined);
  useEffect(() => {
    loadState();
  }, []);
  useEffect(() => {
    if (!publicId) return;
    api.get<Passport>(`/api/devices/${publicId}`).then((p) => {
      setPassport(p);
      const ev = p.events.flatMap((e) => e.evidence);
      setEvidenceId(ev[0]?.id ?? "");
      setSeq(Math.min(1, p.events.length - 1));
    }, setErr);
  }, [publicId]);

  async function act(label: string, fn: () => Promise<any>) {
    setBusy(label);
    setErr(null);
    try {
      const r = await fn();
      const integrity = await api.get<IntegrityReport>(`/api/devices/${publicId}/integrity`).catch(() => null);
      setResult({ action: label, integrity, chain: r?.attempts ? r : undefined, note: r?.note });
      loadState();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy("");
    }
  }
  const evidence = passport?.events.flatMap((e) => e.evidence.filter((v) => v.committedInSeq === e.seq)) ?? [];

  return (
    <Sheet tab="Tamper lab · attack simulation" aside="demo mode only">
      <Notice kind="warn" title="Simulated insider attacks.">
        The first three actions bypass the application and modify the local SQLite database or evidence files directly, as a database administrator or compromised reseller could. The on-chain attempt sends
        real transactions as <b>{actorLabel}</b>. Every change is backed up and can be restored.
      </Notice>
      <ErrorNotice error={err} />
      <div className="form-row">
        <Field label="Device" htmlFor="lab-dev">
          <select id="lab-dev" value={publicId} onChange={(e) => setPublicId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.publicId} value={d.publicId}>
                {d.publicId} — {d.brand} {d.model}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target record" htmlFor="lab-seq">
          <select id="lab-seq" value={seq} onChange={(e) => setSeq(Number(e.target.value))}>
            {passport?.events.map((e) => (
              <option key={e.seq} value={e.seq}>
                {pad(e.seq)} {e.typeLabel} — {e.actor.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target evidence file" htmlFor="lab-ev">
          <select id="lab-ev" value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)}>
            {evidence.length === 0 && <option value="">(no evidence on this device)</option>}
            {evidence.map((v) => (
              <option key={v.id} value={v.id}>
                {v.filename} ({pad(v.committedInSeq)})
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button className="btn danger" disabled={!!busy} onClick={() => act("Edit record in database", () => api.post("/api/lab/edit-record", { publicId, seq }))}>
          Edit record in DB
        </button>
        <button className="btn danger" disabled={!!busy} onClick={() => act("Delete record from database", () => api.post("/api/lab/delete-record", { publicId, seq }))}>
          Delete record from DB
        </button>
        <button className="btn danger" disabled={!!busy || !evidenceId} onClick={() => act("Alter evidence file", () => api.post("/api/lab/alter-evidence", { evidenceId, mode: "file" }))}>
          Alter evidence file
        </button>
        <button className="btn danger" disabled={!!busy || !evidenceId} onClick={() => act("Alter evidence file and DB digest", () => api.post("/api/lab/alter-evidence", { evidenceId, mode: "file-and-db" }))}>
          Alter file + DB digest
        </button>
        <button className="btn" disabled={!!busy} onClick={() => act("On-chain rewrite attempts", () => api.post("/api/lab/chain-attempts", { publicId, seq }))}>
          Attempt on-chain rewrite
        </button>
        <span className="spacer" />
        <button className="btn primary" disabled={!!busy || backups.length === 0} onClick={() => act("Restore", () => api.post("/api/lab/restore"))}>
          Restore all ({backups.length})
        </button>
      </div>
      {busy && <Loading what={busy} />}
      {result && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 8 }}>{result.action}</h3>
          {result.note && <p className="small muted">{result.note}</p>}
          {result.chain && (
            <>
              <table className="ledger" style={{ marginBottom: 12 }}>
                <thead>
                  <tr>
                    <th scope="col">Attempt</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Contract response</th>
                  </tr>
                </thead>
                <tbody>
                  {result.chain.attempts.map((a, i) => (
                    <tr key={i}>
                      <td className="small">{a.attempt}</td>
                      <td>{a.rejected ? <span className="mark ok">rejected</span> : <span className="mark bad">accepted</span>}</td>
                      <td className="small">
                        {a.contractError && <span className="mono">{a.contractError} · </span>}
                        {a.error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small">
                Record {pad(seq)} unchanged on-chain: <b>{String(result.chain.recordUnchanged)}</b> · record count {result.chain.recordCountBefore} → {result.chain.recordCountAfter}. The contract’s only
                state-changing functions are: <span className="mono">{result.chain.mutatingFunctions.join(", ")}</span> — none edits or deletes a record.
              </p>
            </>
          )}
          {result.integrity && <IntegrityPanel report={result.integrity} />}
        </div>
      )}
    </Sheet>
  );
}
