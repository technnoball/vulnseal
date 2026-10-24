import { useState } from "react";
import { ClipboardCheck, Download, RotateCcw, Stamp as StampIcon } from "lucide-react";
import { api, downloadJson } from "../api.ts";
import { useSession } from "../identity.tsx";
import { Check, ErrorNotice, Field, Hash, LedgerPanel, Loading, Notice, PageHead, Sheet, fmtTime, useAction, useLoad } from "../ui.tsx";

interface AuditReport {
  ok: boolean;
  generatedAt: string;
  chain: { chainId: number; contract: string; logHead: string; logCount: number; blockNumber: number };
  counts: Record<string, number>;
  findings: { severity: string; code: string; subject: string; message: string }[];
  logTotal: number;
}

export function Audit() {
  const { me, meta } = useSession();
  const allowed = me?.kind === "auditor" || me?.kind === "governor";
  const [report, setReport] = useState<AuditReport | null>(null);
  const [verifyRes, setVerifyRes] = useState<any>(null);
  const act = useAction();
  const lab = useAction();
  const [labIn, setLabIn] = useState({ revealId: "1", cid: "2", seq: "30", evidenceId: "", aid: "1" });
  const [attempts, setAttempts] = useState<any>(null);
  const access = useLoad(() => (allowed ? api.get<any[]>("/api/access-log") : Promise.resolve([])), [allowed]);
  const labState = useLoad(() => (allowed && meta?.demoLab ? api.get<any[]>("/api/lab/state") : Promise.resolve([])), [allowed, meta?.demoLab]);
  const check = () => act.run("check", async () => setReport(await api.get<AuditReport>("/api/audit/report")));
  const doLab = (label: string, path: string, body: unknown) =>
    lab.run(label, () => api.post(path, body), (r: any) => `${r.action ?? "done"} ${r.target ?? ""}${r.restored !== undefined ? `restored ${r.restored} change(s)` : ""}`).then(() => (labState.reload(), check()));

  if (!allowed) {
    return (
      <>
        <PageHead kicker="Audit & verification" title="Independent audit of the shared record" />
        <Notice kind="warn" title="Sign in as the consortium auditor.">
          The audit view, its export and the tamper lab are available to the auditor identity (read-only on content). Anyone can verify a receipt on the Receipt verifier page.
        </Notice>
      </>
    );
  }
  return (
    <>
      <PageHead
        kicker="Audit & verification"
        title="Is the off-chain record what the ledger committed to?"
        lede="The check recomputes the on-chain hash-chained log, then compares every off-chain record — reports, reveals, evidence, rationales and the event history — with the commitments and digests on-chain."
        actions={
          <>
            <button className="btn primary" onClick={check} disabled={!!act.busy}>
              <ClipboardCheck size={16} aria-hidden="true" /> {act.busy === "check" ? "Checking…" : "Run integrity check"}
            </button>
            <button className="btn" onClick={() => act.run("export", () => downloadJson("/api/audit/export", "audit.json"))}>
              <Download size={16} aria-hidden="true" /> Export audit report
            </button>
            <button className="btn" onClick={() => act.run("attest", () => api.post<any>("/api/audit/attest"), (r: any) => `Attestation recorded on-chain (tx ${r.tx.slice(0, 12)}…) over ${r.logCount} log entries.`)}>
              <StampIcon size={16} aria-hidden="true" /> Attest on-chain
            </button>
          </>
        }
      />
      <ErrorNotice error={act.error} />
      {act.message && <Notice kind="ok">{act.message}</Notice>}
      {report && (
        <div className="grid-2">
          <div>
            <Notice kind={report.ok ? "ok" : "error"} title={report.ok ? "Consistent." : `${report.findings.filter((f) => f.severity === "error").length} integrity error(s).`}>
              Checked {report.counts.logEntries} log entries, {report.counts.commitments} commitments, {report.counts.reveals} reveals, {report.counts.evidence} evidence files, {report.counts.associations} associations and{" "}
              {report.counts.disputes} disputes at {fmtTime(report.generatedAt)}.
            </Notice>
            {report.findings.length > 0 && (
              <Sheet tab="Findings" flush>
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">Severity</th>
                      <th scope="col">Code</th>
                      <th scope="col">Subject</th>
                      <th scope="col">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.findings.map((f, i) => (
                      <tr key={i}>
                        <td>
                          <Check ok={f.severity === "error" ? false : null}>{f.severity}</Check>
                        </td>
                        <td className="mono small">{f.code}</td>
                        <td className="small">{f.subject}</td>
                        <td className="small">{f.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Sheet>
            )}
          </div>
          <LedgerPanel title="Chain state checked">
            <dl className="kv">
              <dt>Contract</dt>
              <dd>
                <Hash value={report.chain.contract} />
              </dd>
              <dt>Log head</dt>
              <dd>
                <Hash value={report.chain.logHead} />
              </dd>
              <dt>Log entries</dt>
              <dd className="mono">{report.chain.logCount}</dd>
              <dt>Block</dt>
              <dd className="mono">{report.chain.blockNumber}</dd>
            </dl>
          </LedgerPanel>
        </div>
      )}
      <div className="grid-halves">
        <Sheet tab="Re-verify an exported audit report offline">
          <p className="small">Recomputes every log entry hash and link from the file alone, without trusting this server.</p>
          <label className="visually-hidden" htmlFor="auditfile">
            Audit export file
          </label>
          <input
            id="auditfile"
            type="file"
            accept=".json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = await act.run("verify-export", async () => api.post("/api/audit/verify-export", JSON.parse(await f.text())));
              setVerifyRes(r ?? null);
            }}
          />
          {verifyRes && (
            <p style={{ marginTop: 8 }}>
              <Check ok={verifyRes.ok}>{verifyRes.ok ? "export verifies: log links and hashes recompute" : verifyRes.problems.join("; ")}</Check>
            </p>
          )}
          <pre className="log" style={{ marginTop: 8 }}>npm run verify-audit -- ~/Downloads/vulnseal-audit-*.json --rpc http://127.0.0.1:8545</pre>
        </Sheet>
        <Sheet tab="Confidential-content access log" flush>
          <div className="table-scroll" style={{ maxHeight: 260 }}>
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Identity</th>
                  <th scope="col">Action</th>
                  <th scope="col">Object</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {(access.data ?? []).slice(0, 60).map((a) => (
                  <tr key={a.id}>
                    <td className="mono small nowrap">{fmtTime(a.at)}</td>
                    <td className="small">{a.identity_id}</td>
                    <td className="small">{a.action}</td>
                    <td className="mono small">{a.object}</td>
                    <td>
                      <Check ok={!!a.allowed}>{a.allowed ? "allowed" : "denied"}</Check>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Sheet>
      </div>
      {meta?.demoLab && (
        <Sheet tab="Tamper lab · simulated insider attacks" aside="demo mode only">
          <Notice kind="warn" title="Simulated insider.">
            These actions bypass the application and rewrite the off-chain database, evidence store or vault contents (with the real encryption key), as a compromised operator could. Run the integrity
            check after each one. Every change is backed up; "Restore" undoes them.
          </Notice>
          <ErrorNotice error={lab.error} />
          {lab.message && <Notice kind="ok">{lab.message}</Notice>}
          <div className="form-row">
            <Field label="Reveal id" htmlFor="l-rv">
              <input id="l-rv" inputMode="numeric" value={labIn.revealId} onChange={(e) => setLabIn({ ...labIn, revealId: e.target.value })} />
            </Field>
            <Field label="Report number (cid)" htmlFor="l-cid">
              <input id="l-cid" inputMode="numeric" value={labIn.cid} onChange={(e) => setLabIn({ ...labIn, cid: e.target.value })} />
            </Field>
            <Field label="Log entry #" htmlFor="l-seq">
              <input id="l-seq" inputMode="numeric" value={labIn.seq} onChange={(e) => setLabIn({ ...labIn, seq: e.target.value })} />
            </Field>
            <Field label="Association #" htmlFor="l-aid">
              <input id="l-aid" inputMode="numeric" value={labIn.aid} onChange={(e) => setLabIn({ ...labIn, aid: e.target.value })} />
            </Field>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn danger" disabled={!!lab.busy} onClick={() => doLab("rv", "/api/lab/alter-reveal", { revealId: Number(labIn.revealId) })}>
              Rewrite a stored reveal
            </button>
            <button className="btn danger" disabled={!!lab.busy} onClick={() => doLab("cm", "/api/lab/alter-commitment", { cid: Number(labIn.cid) })}>
              Replace a stored commitment
            </button>
            <button className="btn danger" disabled={!!lab.busy} onClick={() => doLab("ev", "/api/lab/delete-event", { seq: Number(labIn.seq) })}>
              Delete a status event
            </button>
            <button className="btn danger" disabled={!!lab.busy} onClick={() => doLab("ra", "/api/lab/alter-rationale", { aid: Number(labIn.aid) })}>
              Edit a review rationale
            </button>
            <button className="btn" disabled={!!lab.busy} onClick={() => lab.run("chain", async () => setAttempts(await api.post("/api/lab/chain-attempts", { cid: Number(labIn.cid) })))}>
              Attempt on-chain rewrites
            </button>
            <span className="spacer" />
            <button className="btn primary" disabled={!!lab.busy || (labState.data ?? []).length === 0} onClick={() => doLab("restore", "/api/lab/restore", {})}>
              <RotateCcw size={16} aria-hidden="true" /> Restore ({(labState.data ?? []).length})
            </button>
          </div>
          {attempts && (
            <table className="ledger" style={{ marginTop: 16 }}>
              <thead>
                <tr>
                  <th scope="col">Attempt (real transaction)</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Contract response</th>
                </tr>
              </thead>
              <tbody>
                {attempts.attempts.map((a: any, i: number) => (
                  <tr key={i}>
                    <td className="small">{a.attempt}</td>
                    <td>
                      <Check ok={a.rejected}>{a.rejected ? "rejected" : "accepted"}</Check>
                    </td>
                    <td className="small">
                      <span className="mono">{a.contractError}</span> {a.error}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="small">
                    On-chain record unchanged: <b>{String(attempts.unchanged)}</b>. State-changing functions in the contract: <span className="mono">{attempts.mutatingFunctions.join(", ")}</span> — none edits or deletes a commitment.
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </Sheet>
      )}
      {!report && !act.busy && <Loading what="Run the integrity check to see results" />}
    </>
  );
}
