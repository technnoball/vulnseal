import { useState } from "react";
import { api, type EventView, type IntegrityReport, type Passport } from "../api.ts";
import { useIdentity } from "../identity.tsx";
import { Link, useLocation } from "../router.tsx";
import {
  ErrorNotice,
  Hash,
  Loading,
  Notice,
  PageHead,
  Sheet,
  Stamp,
  SyntheticTag,
  anchorMark,
  fmtBytes,
  fmtDate,
  fmtTime,
  integrityMark,
  pad,
  useLoad,
} from "../ui.tsx";

const CLAIM = (t: string) => t !== "CHALLENGE" && t !== "RESOLUTION";

function RefLine({ e, events }: { e: EventView; events: EventView[] }) {
  if (e.refSeq === null) return null;
  const target = events[e.refSeq];
  const tl = target ? `${pad(target.seq)} ${target.typeLabel}` : pad(e.refSeq);
  const verb: Record<string, string> = {
    CORRECTION: "Corrects",
    CHALLENGE: "Challenges",
    RESOLUTION: "Resolves challenge",
    CORROBORATION: "Corroborates",
    EVIDENCE_ATTACHMENT: "Adds evidence to",
  };
  return (
    <div className="refline">
      {verb[e.type] ?? "References"} <a href={`#rec-${e.refSeq}`}>{tl}</a>
      {target && <span className="muted"> by {target.actor.label}</span>}
      {e.type === "RESOLUTION" && (
        <>
          {" "}
          — <strong>{e.outcomeLabel}</strong>
        </>
      )}
    </div>
  );
}

function Facts({ p }: { p: Record<string, any> }) {
  const items: [string, string][] = [];
  if (p.claimedAt) items.push(["Performed", fmtDate(p.claimedAt)]);
  if (p.category) items.push(["Category", p.category]);
  if (p.component) items.push(["Component", p.component]);
  if (p.result) items.push(["Result", p.result]);
  if (p.partOrigin) items.push(["Part origin", p.partOrigin]);
  if (p.fromParty) items.push(["From", p.fromParty]);
  if (p.toParty) items.push(["To", p.toParty]);
  for (const [k, v] of Object.entries((p.measurements ?? {}) as Record<string, unknown>)) items.push([k, String(v)]);
  for (const a of (p.componentAssertions ?? []) as { component: string; state: string }[]) items.push([`asserts ${a.component}`, a.state]);
  if (!items.length) return null;
  return (
    <div className="facts">
      {items.map(([k, v], i) => (
        <span key={i}>
          <b>{k}</b>
          {v}
        </span>
      ))}
    </div>
  );
}

function EvidenceList({ e }: { e: EventView }) {
  if (!e.evidence.length) return null;
  return (
    <div className="evlist" aria-label="Evidence">
      <div className="evhead">Evidence · {e.evidence.length} file(s) · SHA-256 committed in payload</div>
      {e.evidence.map((v) => (
        <div className="evrow" key={v.id + v.committedInSeq}>
          <div>
            <Link to={`/evidence/${v.id}`}>{v.filename || v.id}</Link>
            <div className="small muted">
              {v.kind} · {fmtBytes(v.size)} · by {v.uploadedBy.label}
              {v.committedInSeq !== e.seq && ` · attached in ${pad(v.committedInSeq)}`}
            </div>
          </div>
          <div>
            <Hash value={v.sha256} />
            {v.reusedElsewhere.length > 0 && <div className="small" style={{ color: "var(--vermilion-ink)" }}>identical file also submitted as {v.reusedElsewhere.map((r) => r.id).join(", ")}</div>}
          </div>
          <div>{integrityMark(v.integrity)}</div>
        </div>
      ))}
    </div>
  );
}

function Entry({ e, events, publicId, highlight }: { e: EventView; events: EventView[]; publicId: string; highlight: boolean }) {
  const p = e.payload;
  const text = p.description ?? p.reason ?? (e.type === "REGISTRATION" ? `${p.brand} ${p.model}${p.year ? ` (${p.year})` : ""} registered as a ${p.formFactor}.` : "");
  const rec = (type: string) => `/devices/${publicId}/record?type=${type}&ref=${e.seq}`;
  return (
    <li className={`entry t-${e.type} ${e.category}${highlight ? " highlight" : ""}`} id={`rec-${e.seq}`}>
      <span className="seq" aria-hidden="true">
        {pad(e.seq)}
      </span>
      <article className="slip" aria-labelledby={`rec-${e.seq}-title`}>
        <div className="slip-head">
          <div>
            <div className="type" id={`rec-${e.seq}-title`}>
              <span className="visually-hidden">Record {e.seq}: </span>
              {e.typeLabel}
            </div>
            <div className="who">
              {e.actor.label} · <span className="small">{e.actor.description}</span>
            </div>
          </div>
          <div className="row">
            <Stamp category={e.category} label={e.categoryLabel} />
          </div>
        </div>
        <div className="slip-body">
          <RefLine e={e} events={events} />
          {text && <p className="desc">{text}</p>}
          {e.type === "CORRECTION" && p.corrected && (
            <div className="well small">
              <b className="mono">CORRECTED CLAIM · </b>
              {p.corrected.description ?? "—"}
              <Facts p={p.corrected} />
            </div>
          )}
          <Facts p={p} />
          <EvidenceList e={e} />
          {e.flags.length > 0 && (
            <ul className="flags">
              {e.flags.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          {(e.supersededBySeq !== null || e.challenges.length > 0 || e.corroboratedBySeqs.length > 0) && (
            <div className="small">
              {e.supersededBySeq !== null && (
                <div>
                  Superseded by <a href={`#rec-${e.supersededBySeq}`}>{pad(e.supersededBySeq)} correction</a> — the original text above is preserved unchanged.
                </div>
              )}
              {e.corroboratedBySeqs.length > 0 && <div>Corroborated by {e.corroboratedBySeqs.map((s) => <a key={s} href={`#rec-${s}`}>{pad(s)} </a>)}</div>}
              {e.challenges.map((c) => (
                <div key={c.seq}>
                  Challenged in <a href={`#rec-${c.seq}`}>{pad(c.seq)}</a> —{" "}
                  {c.resolvedBySeq === null ? (
                    <strong style={{ color: "var(--vermilion-ink)" }}>unresolved</strong>
                  ) : (
                    <>
                      resolved in <a href={`#rec-${c.resolvedBySeq}`}>{pad(c.resolvedBySeq)}</a>: {c.outcome?.replace(/_/g, " ").toLowerCase()}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="slip-foot">
          <div className="row small">
            <span className="mono" title="Ledger (block) time">
              recorded {fmtTime(e.recordedAt)}
            </span>
            {anchorMark(e.anchor)}
          </div>
          <div className="actions">
            {CLAIM(e.type) && (
              <>
                <Link className="btn quiet" to={rec("EVIDENCE_ATTACHMENT")}>
                  Attach evidence
                </Link>
                <Link className="btn quiet" to={rec("CORROBORATION")}>
                  Corroborate
                </Link>
                {e.openChallengeSeq === null && (
                  <Link className="btn quiet" to={rec("CHALLENGE")}>
                    Challenge
                  </Link>
                )}
                {e.supersededBySeq === null && (
                  <Link className="btn quiet" to={rec("CORRECTION")}>
                    Correct
                  </Link>
                )}
              </>
            )}
            {e.type === "CHALLENGE" && !events.some((r) => r.type === "RESOLUTION" && r.refSeq === e.seq) && (
              <Link className="btn quiet danger" to={rec("RESOLUTION")}>
                Resolve dispute
              </Link>
            )}
          </div>
        </div>
        <div style={{ padding: "0 16px 10px" }}>
          <details className="chain">
            <summary>Ledger commitment</summary>
            <dl className="kv">
              <dt>Record hash</dt>
              <dd>
                <Hash value={e.recordHash} full />
              </dd>
              <dt>Previous hash</dt>
              <dd>
                <Hash value={e.prevHash} full />
              </dd>
              <dt>Payload digest</dt>
              <dd>
                <Hash value={e.payloadDigest} full />
              </dd>
              <dt>Actor address</dt>
              <dd>
                <Hash value={e.actor.address} full />
              </dd>
              <dt>Transaction</dt>
              <dd>
                <Hash value={e.txHash} /> <span className="mono small">block {e.blockNumber} · {e.gasUsed} gas</span>
              </dd>
            </dl>
          </details>
        </div>
      </article>
    </li>
  );
}

export function IntegrityPanel({ report }: { report: IntegrityReport }) {
  return (
    <div>
      <Notice kind={report.ok ? "ok" : "error"} title={report.ok ? "Integrity verified." : "Integrity check failed."}>
        {report.chain.onChainRecords} on-chain / {report.chain.offChainRecords} off-chain records, {report.evidenceChecked} evidence commitments checked, contract verifyChain() ={" "}
        {String(report.chain.contractVerifyChain)}. Checked {fmtTime(report.checkedAt)}.
      </Notice>
      {report.findings.length > 0 && (
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Finding</th>
              <th scope="col">Record</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {report.findings.map((f, i) => (
              <tr key={i}>
                <td>
                  <span className={`mark ${f.severity === "error" ? "bad" : "warn"}`}>{f.severity}</span>
                </td>
                <td className="mono small">{f.code}</td>
                <td className="mono">{f.seq !== undefined ? pad(f.seq) : ""}</td>
                <td className="small">{f.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PassportPage({ publicId }: { publicId: string }) {
  const { actor } = useIdentity();
  const { search } = useLocation();
  const highlight = search.get("new");
  const { data, error, loading, reload } = useLoad(() => api.get<Passport>(`/api/devices/${encodeURIComponent(publicId)}`), [publicId, actor?.id]);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<unknown>(null);

  async function runCheck() {
    setChecking(true);
    setCheckErr(null);
    try {
      setIntegrity(await api.get<IntegrityReport>(`/api/devices/${encodeURIComponent(publicId)}/integrity`));
      reload();
    } catch (e) {
      setCheckErr(e);
    } finally {
      setChecking(false);
    }
  }

  if (error) return <ErrorNotice error={error} />;
  if (loading && !data) return <Loading what="Loading passport" />;
  if (!data) return null;
  const d = data.device;
  const openConflicts = data.conflicts.filter((c) => c.status === "open");

  return (
    <>
      <PageHead
        kicker={`Device passport · ${d.formFactor}${d.year ? ` · ${d.year}` : ""}`}
        title={`${d.brand} ${d.model}`}
        lede={
          <>
            <span className="idplate">{d.publicId}</span> {d.synthetic && <SyntheticTag />}
          </>
        }
        actions={
          <>
            <Link className="btn primary" to={`/devices/${d.publicId}/record`}>
              Record new event
            </Link>
            <button className="btn" onClick={runCheck} disabled={checking}>
              {checking ? "Verifying…" : "Verify integrity"}
            </button>
            <a className="btn" href={`/api/devices/${d.publicId}/export`} download>
              Export JSON
            </a>
            <a className="btn" href={`/api/devices/${d.publicId}/report`} download>
              Verification report
            </a>
          </>
        }
      />
      {highlight !== null && (
        <Notice kind="ok" title="Committed.">
          Record {pad(Number(highlight))} was mined on the local chain and stored off-chain. <a href={`#rec-${highlight}`}>Jump to it</a>.
        </Notice>
      )}
      {data.chainError && <Notice kind="error" title="Ledger node unavailable — showing the off-chain copy only.">{data.chainError}</Notice>}
      <ErrorNotice error={checkErr} />
      {integrity && (
        <Sheet tab="Integrity check — off-chain records vs on-chain commitments">
          <IntegrityPanel report={integrity} />
        </Sheet>
      )}

      <div className="passport-head">
        <div className="strip" role="group" aria-label="Passport status">
          <div>
            <b>Records</b>
            <span className="mono">
              {data.events.length} off-chain / {data.onChainRecords ?? "?"} on-chain
            </span>
          </div>
          <div>
            <b>Head hash</b>
            <Hash value={data.onChainHeadHash ?? data.headHash} />
          </div>
          <div>
            <b>Open disputes</b>
            <span className="mono">{data.openDisputes}</span>
          </div>
          <div>
            <b>Component conflicts</b>
            <span className="mono">{openConflicts.length} open</span>
          </div>
          <div>
            <b>Device key</b>
            <Hash value={d.deviceKey} />
          </div>
        </div>
        <div className="qr">
          <img src={`/api/devices/${d.publicId}/qr.svg`} alt={`QR code linking to the public verification page for ${d.publicId}`} />
          <div className="cap">
            <Link to={`/verify/${d.publicId}`}>public verify page</Link>
          </div>
        </div>
      </div>

      {data.conflicts.length > 0 && (
        <Notice kind={openConflicts.length ? "error" : "warn"} title="Conflicting claims detected.">
          {data.conflicts.map((c, i) => (
            <div key={i}>
              <b>{c.component}</b>: replacement in <a href={`#rec-${c.replacedSeq}`}>{pad(c.replacedSeq)}</a> vs. “original” asserted in{" "}
              <a href={`#rec-${c.assertedOriginalSeq}`}>{pad(c.assertedOriginalSeq)}</a> — {c.status}: {c.note}.
            </div>
          ))}
        </Notice>
      )}

      {data.pendingEvidence.length > 0 && (
        <Notice kind="warn" title="Uploaded evidence not yet committed:">
          {data.pendingEvidence.map((v) => (
            <Link key={v.id} to={`/evidence/${v.id}`}>
              {v.filename}{" "}
            </Link>
          ))}
          — attach it when you record an event.
        </Notice>
      )}

      <h2 style={{ margin: "8px 0 16px" }}>Chronological record</h2>
      <p className="small muted" style={{ maxWidth: "80ch" }}>
        “Recorded” is the block time at which the claim entered the ledger. “Performed” is the date the submitter claims the work happened — the ledger can show who claimed it and when, not that it is true.
      </p>
      <ol className="timeline">
        {data.events.map((e) => (
          <Entry key={e.seq} e={e} events={data.events} publicId={d.publicId} highlight={highlight === String(e.seq)} />
        ))}
      </ol>
    </>
  );
}
