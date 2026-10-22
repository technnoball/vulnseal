import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { Link, navigate } from "../router.tsx";
import { ErrorNotice, Hash, Loading, Notice, Stamp, fmtDate, fmtTime, integrityMark, pad, useLoad } from "../ui.tsx";

interface PublicView {
  device: { publicId: string; brand: string; model: string; year: number | null; formFactor: string; synthetic: boolean };
  events: {
    seq: number;
    type: string;
    typeLabel: string;
    recordedAt: string;
    claimedAt: string | null;
    actorLabel: string;
    actorRole: string;
    category: string | null;
    component: string | null;
    result: string | null;
    partOrigin: string | null;
    outcome: string | null;
    refSeq: number | null;
    evidenceCategory: string;
    evidenceCategoryLabel: string;
    openChallengeSeq: number | null;
    supersededBySeq: number | null;
    flags: string[];
    anchor: string;
    recordHash: string;
    evidence: { kind: string; sha256: string; integrity: string }[];
  }[];
  conflicts: { component: string; replacedSeq: number; assertedOriginalSeq: number; status: string }[];
  openDisputes: number;
  integrity: { ok: boolean; checkedAt: string; errors: number; warnings: number; findings: { severity: string; code: string; seq?: number; message: string }[]; headHash: string | null; contract: string };
}

function Lookup() {
  const [id, setId] = useState("");
  const [err, setErr] = useState("");
  const go = (e: FormEvent) => {
    e.preventDefault();
    const v = id.trim().toUpperCase();
    if (!/^PL-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(v)) return setErr("Enter an ID in the form PL-XXXX-XXXX (printed under the device QR code).");
    navigate(`/verify/${v}`);
  };
  return (
    <form onSubmit={go} className="form" noValidate style={{ maxWidth: 480 }}>
      <div className="field">
        <label htmlFor="pid">Device public ID</label>
        <input id="pid" value={id} onChange={(e) => setId(e.target.value)} placeholder="PL-XXXX-XXXX" aria-invalid={!!err} aria-describedby={err ? "pid-err" : undefined} />
        {err && (
          <div className="err" id="pid-err">
            {err}
          </div>
        )}
      </div>
      <div>
        <button className="btn primary">Verify history</button>
      </div>
    </form>
  );
}

export function Verify({ publicId }: { publicId?: string }) {
  return (
    <div className="doc">
      <div className="doc-mast">
        <div>
          <div className="mono small" style={{ letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--vermilion-ink)" }}>
            PatchLedger · public verification
          </div>
          <h1>Repair history check</h1>
        </div>
        <Link to="/" className="small">
          Open full application
        </Link>
      </div>
      {publicId ? <Report publicId={publicId} /> : <Lookup />}
      <p className="small muted" style={{ marginTop: 32, maxWidth: "80ch" }}>
        This read-only page shows structured facts, evidence categories and integrity results. It never shows evidence contents, free-text descriptions or personal data. A passing check means the recorded
        history has not been altered since it was recorded on the ledger; it does not certify that every claim is true. Research prototype on a local development chain.
      </p>
    </div>
  );
}

function Report({ publicId }: { publicId: string }) {
  const { data, error, loading } = useLoad(() => api.get<PublicView>(`/api/public/devices/${encodeURIComponent(publicId)}`), [publicId]);
  if (error) return <ErrorNotice error={error} />;
  if (loading && !data) return <Loading what="Verifying" />;
  if (!data) return null;
  const d = data.device;
  const open = data.conflicts.filter((c) => c.status === "open");
  return (
    <>
      <h2>
        {d.brand} {d.model} <span className="muted">{d.year ?? ""}</span>
      </h2>
      <p>
        <span className="idplate">{d.publicId}</span> {d.synthetic && <span className="synthetic-tag">synthetic demo record</span>}
      </p>
      <div className={`verdict ${data.integrity.ok ? "pass" : "fail"}`} role="status">
        <span className="big">{data.integrity.ok ? "INTACT" : "ALTERED"}</span>
        <div>
          <strong>{data.integrity.ok ? "Recorded history matches its on-chain commitments." : `${data.integrity.errors} integrity error(s): the stored history no longer matches the ledger.`}</strong>
          <div className="small">
            {data.events.length} records · {data.openDisputes} unresolved dispute(s) · {open.length} open component conflict(s) · checked {fmtTime(data.integrity.checkedAt)}
          </div>
          <div className="small">
            head <Hash value={data.integrity.headHash} /> · contract <Hash value={data.integrity.contract} />
          </div>
        </div>
      </div>
      {data.openDisputes > 0 && <Notice kind="error" title="Unresolved dispute.">At least one claim in this history is under challenge and has not been resolved by an auditor.</Notice>}
      {open.map((c, i) => (
        <Notice key={i} kind="warn" title="Conflicting claims.">
          The {c.component} is recorded as replaced in {pad(c.replacedSeq)} but asserted original in {pad(c.assertedOriginalSeq)}.
        </Notice>
      ))}
      {data.integrity.findings.filter((f) => f.severity === "error").map((f, i) => (
        <Notice key={i} kind="error" title={f.code}>
          {f.message}
        </Notice>
      ))}
      <div className="table-scroll">
        <table className="ledger">
          <caption className="visually-hidden">Permitted history</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Record</th>
              <th scope="col">By</th>
              <th scope="col">Performed / recorded</th>
              <th scope="col">Facts</th>
              <th scope="col">Evidence status</th>
              <th scope="col">Evidence integrity</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.seq}>
                <td className="mono">{pad(e.seq)}</td>
                <td>
                  {e.typeLabel}
                  {e.refSeq !== null && <div className="small muted">re {pad(e.refSeq)}</div>}
                  {e.outcome && <div className="small">{e.outcome}</div>}
                </td>
                <td className="small">
                  {e.actorLabel}
                  <div className="muted">{e.actorRole}</div>
                </td>
                <td className="small mono">
                  {e.claimedAt ? fmtDate(e.claimedAt) : "—"}
                  <div className="muted">{fmtTime(e.recordedAt)}</div>
                </td>
                <td className="small">{[e.category, e.component, e.result, e.partOrigin].filter(Boolean).join(" · ") || "—"}</td>
                <td>
                  {e.evidenceCategory !== "dispute-record" ? <Stamp category={e.evidenceCategory} label={e.evidenceCategoryLabel} /> : <span className="small muted">dispute record</span>}
                  {e.supersededBySeq !== null && <div className="small muted">superseded by {pad(e.supersededBySeq)}</div>}
                </td>
                <td className="small">
                  {e.evidence.length === 0 ? <span className="muted">none</span> : e.evidence.map((v, i) => <div key={i}>{v.kind}: {integrityMark(v.integrity)}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
