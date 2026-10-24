import { useState } from "react";
import { Download, Eye, FileSearch, Gavel, Link2, ShieldCheck } from "lucide-react";
import { api, downloadJson, type Actor, type AssociationView, type DisputeSummary, type LedgerEvent, type Program } from "../api.ts";
import { useSession } from "../identity.tsx";
import { Link, navigate } from "../router.tsx";
import { Check, ErrorNotice, Field, Hash, LedgerPanel, Loading, Notice, PageHead, Sealed, Sheet, StateStamp, Withheld, fmtBytes, fmtTime, short, useAction, useLoad } from "../ui.tsx";

export interface ReportView {
  cid: number;
  ref: string;
  program: Program;
  researcher: Actor;
  commitment: string;
  policyVersion: number;
  status: number;
  statusName: string;
  mismatches: number;
  revealDigest: string | null;
  family: string | null;
  anchoredAt: string;
  supersedes: number | null;
  supersededBy: number | null;
  tx: { hash: string; blockNumber: number; gasUsed: number };
  logSeq: number;
  isOwner: boolean;
  isStaff: boolean;
  access: { allowed: boolean; scope: string; reason: string };
  content: null | {
    source: string;
    title: string;
    severity: string;
    scope: string;
    description: string;
    impact: string;
    reproduction: string;
    privateNotes?: string;
    evidence: string[];
    evidenceFiles: { id: string; sha256: string; size: number; mime: string; filename: string; committed: boolean }[];
  };
  reveals: { id: number; submitted_at: string; source: string; precheck: string; verified_by: string | null; verified_at: string | null; outcome: string | null; reveal_digest: string | null; tx_hash: string | null }[];
  notes: { id: number; author: string; createdAt: string; body: string }[];
  grants: { to_program: number; granted_by: string; tx_hash: string; created_at: string }[];
  associations: AssociationView[];
  disputes: DisputeSummary[];
  timeline: LedgerEvent[];
}

const ref = (cid: number) => `VS-${String(cid).padStart(4, "0")}`;
const FIELDS: [keyof NonNullable<ReportView["content"]>, string][] = [
  ["title", "Title"],
  ["severity", "Claimed severity"],
  ["scope", "Scope"],
  ["description", "Description"],
  ["impact", "Impact"],
  ["reproduction", "Reproduction notes"],
];

function ReceiptCheck({ cid }: { cid: number }) {
  const act = useAction();
  const [res, setRes] = useState<any>(null);
  return (
    <div>
      <button
        className="btn quiet"
        disabled={!!act.busy}
        onClick={() =>
          act.run("verify", async () => {
            const receipt = await api.get(`/api/reports/${cid}/receipt`);
            setRes(await api.post("/api/verify/receipt", { receipt }));
          })
        }
      >
        <ShieldCheck size={14} aria-hidden="true" /> {act.busy ? "Checking against the chain…" : "Verify the receipt against the chain"}
      </button>
      <ErrorNotice error={act.error} />
      {res && (
        <div style={{ marginTop: 8 }}>
          <Check ok={res.verdict === "valid"}>receipt {res.verdict}</Check>
          <ul className="checklist" style={{ marginTop: 6 }}>
            {res.checks.map((c: any) => (
              <li key={c.check}>
                <Check ok={c.ok}>{c.check}</Check>
                <span className="small muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RevealPanel({ r, reload }: { r: ReportView; reload: () => void }) {
  const [mode, setMode] = useState<"vault" | "edited" | "package">("vault");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pkgText, setPkgText] = useState("");
  const act = useAction();
  const [result, setResult] = useState<any>(null);
  const submit = async () => {
    const body: any = { mode };
    if (mode === "edited") body.edits = edits;
    if (mode === "package") body.package = pkgText;
    const res = await act.run("reveal", () => api.post(`/api/reports/${r.cid}/reveal`, body));
    if (res) {
      setResult(res);
      reload();
    }
  };
  return (
    <Sheet tab="Reveal to the program" aside="the program requested a reveal">
      <p className="small">
        Revealing discloses the report and nonce to {r.program.name}'s staff only. They recompute the commitment and record the outcome on-chain. A revealed copy that differs from what you committed is detected and the mismatch stays on
        the record.
      </p>
      <fieldset>
        <legend>What to reveal</legend>
        {(
          [
            ["vault", "The sealed original from my vault (should match)"],
            ["edited", "An edited copy (demonstrates that altered content is detected)"],
            ["package", "Upload a reveal package file (e.g. the recovery package)"],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="small radio-line">
            <input type="radio" name="mode" value={v} checked={mode === v} onChange={() => setMode(v)} /> {label}
          </label>
        ))}
      </fieldset>
      {mode === "edited" && r.content && (
        <div className="form" style={{ marginTop: 12 }}>
          {(["title", "impact", "severity"] as const).map((k) => (
            <Field key={k} label={`Revealed ${k}`} htmlFor={`edit-${k}`}>
              <input id={`edit-${k}`} defaultValue={r.content![k] as string} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}
      {mode === "package" && (
        <div style={{ marginTop: 12 }}>
          <label className="visually-hidden" htmlFor="pkgfile">
            Reveal package file
          </label>
          <input
            id="pkgfile"
            type="file"
            accept=".json,application/json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setPkgText(f ? await f.text() : "");
            }}
          />
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={submit} disabled={!!act.busy || (mode === "package" && !pkgText)}>
          <Eye size={16} aria-hidden="true" /> {act.busy ? "Revealing…" : "Reveal to the program"}
        </button>
      </div>
      <ErrorNotice error={act.error} />
      {result && (
        <Notice kind={result.precheck.outcome === "match" ? "ok" : "error"} title={`Pre-check: ${result.precheck.outcome}.`}>
          {result.precheck.outcome === "match"
            ? "The revealed content opens your commitment. The program will verify it and record the result on-chain."
            : result.precheck.outcome === "mismatch"
              ? "The revealed content does NOT open your commitment. If the program records this, the mismatch stays on the ledger permanently."
              : `Problem: ${(result.precheck.missing ?? result.precheck.problems ?? []).join("; ")}`}
        </Notice>
      )}
    </Sheet>
  );
}

function StaffActions({ r, reload }: { r: ReportView; reload: () => void }) {
  const { me, meta } = useSession();
  const act = useAction();
  const [note, setNote] = useState("");
  const [assoc, setAssoc] = useState({ other: "", relation: "1", rationale: "" });
  const [grantTo, setGrantTo] = useState("");
  const { data: explorer } = useLoad(() => api.get<any>("/api/explorer"), []);
  const s = r.statusName;
  const pending = r.reveals.filter((x) => !x.outcome);
  const isAdmin = me?.kind === "program-admin";
  const go = (label: string, fn: () => Promise<unknown>, ok: string) => act.run(label, fn, () => ok).then((x) => (x !== undefined ? reload() : undefined));
  const candidates = (explorer?.commitments ?? []).filter((c: any) => c.programId !== r.program.id && !c.supersededBy && ["revealed", "pending triage", "needs info", "valid", "invalid", "finalized"].includes(c.statusName));
  return (
    <Sheet tab={`Program actions — ${r.program.short}`} aside={me?.label}>
      <ErrorNotice error={act.error} />
      {act.message && <Notice kind="ok">{act.message}</Notice>}
      <div className="stack">
        {s === "anchored" && (
          <button className="btn" disabled={!!act.busy} onClick={() => go("ack", () => api.post(`/api/reports/${r.cid}/acknowledge`), "Acknowledged on-chain.")}>
            Acknowledge commitment
          </button>
        )}
        {s === "acknowledged" && (
          <button className="btn" disabled={!!act.busy} onClick={() => go("req", () => api.post(`/api/reports/${r.cid}/request-reveal`), "Reveal requested on-chain.")}>
            Request reveal from the researcher
          </button>
        )}
        {pending.map((p) => (
          <div key={p.id} className="well small">
            Reveal #{p.id} submitted {fmtTime(p.submitted_at)} — pre-check <StateStamp state={p.precheck} />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                disabled={!!act.busy}
                onClick={() => act.run("verify", () => api.post<any>(`/api/reveals/${p.id}/verify`), (x: any) => `Recorded on-chain: ${x.outcome}.`).then((x) => x && reload())}
              >
                <FileSearch size={14} aria-hidden="true" /> Verify and record outcome on-chain
              </button>
            </div>
          </div>
        ))}
        {["revealed", "pending triage", "needs info"].includes(s) && (
          <div className="well">
            <Field label="Triage note (sealed; its salted digest goes on-chain)" htmlFor="tnote">
              <textarea id="tnote" value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 60 }} />
            </Field>
            <div className="row" style={{ marginTop: 8 }}>
              {(s === "revealed" ? [["pending-triage", "Start triage"]] : s === "pending triage" ? [["needs-info", "Needs more information"], ["valid", "Valid"], ["invalid", "Invalid"]] : [["pending-triage", "Back to triage"], ["valid", "Valid"], ["invalid", "Invalid"]]).map(([t, label]) => (
                <button key={t} className="btn quiet" disabled={!!act.busy} onClick={() => go("triage", () => api.post(`/api/reports/${r.cid}/triage`, { target: t, note }), `Triage recorded: ${label}.`)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {isAdmin && ["valid", "invalid"].includes(s) && (
          <button className="btn" disabled={!!act.busy || !note.trim()} title="Write the disposition note in the triage note box" onClick={() => go("final", () => api.post(`/api/reports/${r.cid}/finalize`, { note: note || "Final disposition" }), "Final disposition recorded.")}>
            Record final disposition
          </button>
        )}
        {isAdmin && r.status >= 4 && (
          <div className="row">
            <label className="visually-hidden" htmlFor="grant">
              Grant disclosure to
            </label>
            <select id="grant" value={grantTo} onChange={(e) => setGrantTo(e.target.value)} style={{ width: 220 }}>
              <option value="">Disclose to program…</option>
              {meta?.programs.filter((p) => p.id !== r.program.id).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.short} — {p.name}
                </option>
              ))}
            </select>
            <button className="btn quiet" disabled={!grantTo || !!act.busy} onClick={() => go("grant", () => api.post(`/api/reports/${r.cid}/grant`, { toProgram: Number(grantTo) }), "Disclosure granted on-chain.")}>
              Grant
            </button>
          </div>
        )}
        {r.status >= 4 && (
          <details>
            <summary className="small">
              <Link2 size={14} aria-hidden="true" /> Propose a cross-program association
            </summary>
            <div className="form" style={{ marginTop: 8 }}>
              <Field label="Other report (another program, revealed)" htmlFor="other">
                <select id="other" value={assoc.other} onChange={(e) => setAssoc({ ...assoc, other: e.target.value })}>
                  <option value="">— choose —</option>
                  {candidates.map((c: any) => (
                    <option key={c.cid} value={c.cid}>
                      {c.ref} · {c.program} · {c.researcher.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Relationship" htmlFor="rel">
                <select id="rel" value={assoc.relation} onChange={(e) => setAssoc({ ...assoc, relation: e.target.value })}>
                  <option value="1">Same underlying issue</option>
                  <option value="2">Related but distinct</option>
                  <option value="3">Distinct issues</option>
                </select>
              </Field>
              <Field label="Rationale (sealed; salted digest on-chain)" htmlFor="why" hint="You must have read both reports (yours after reveal, the other after a disclosure grant).">
                <textarea id="why" value={assoc.rationale} onChange={(e) => setAssoc({ ...assoc, rationale: e.target.value })} style={{ minHeight: 60 }} />
              </Field>
              <button
                className="btn"
                disabled={!assoc.other || !assoc.rationale.trim() || !!act.busy}
                onClick={() => go("assoc", () => api.post("/api/associations", { cidA: r.cid, cidB: Number(assoc.other), relation: Number(assoc.relation), rationale: assoc.rationale }), "Association proposed on-chain; the other program must review it.")}
              >
                Propose association
              </button>
            </div>
          </details>
        )}
        <details>
          <summary className="small">Add a private review note</summary>
          <AddNote cid={r.cid} reload={reload} />
        </details>
      </div>
    </Sheet>
  );
}

function AddNote({ cid, reload }: { cid: number; reload: () => void }) {
  const [body, setBody] = useState("");
  const act = useAction();
  return (
    <div className="form" style={{ marginTop: 8 }}>
      <label className="visually-hidden" htmlFor="note">
        Note
      </label>
      <textarea id="note" value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 60 }} />
      <button className="btn quiet" disabled={!body.trim() || !!act.busy} onClick={() => act.run("note", () => api.post(`/api/reports/${cid}/notes`, { body })).then((x) => x && (setBody(""), reload()))}>
        Save note
      </button>
      <ErrorNotice error={act.error} />
    </div>
  );
}

export function AssociationCard({ a, reload }: { a: AssociationView; reload: () => void }) {
  const { me, meta } = useSession();
  const act = useAction();
  const [why, setWhy] = useState("");
  const myShort = meta?.programs.find((p) => p.id === me?.programId)?.short;
  const staff = me?.kind === "program-admin" || me?.kind === "reviewer";
  // the contract only accepts a review from staff of the program that did not propose it
  const proposerProgram = meta?.identities.find((i) => i.id === a.proposer.id)?.programId;
  const canReview = staff && a.statusName === "proposed" && !!myShort && a.programs.includes(myShort) && proposerProgram !== me?.programId;
  return (
    <div className="well small" style={{ marginBottom: 12 }}>
      <div className="row">
        <strong>Association #{a.aid}</strong> {a.refA} ↔ {a.refB} ({a.programs.join(" / ")}) <span className="spacer" />
        <StateStamp state={a.statusName} />
      </div>
      <div style={{ marginTop: 6 }}>
        Proposed relation: <b>{a.relationName}</b> by {a.proposer.label}
        {a.reviewer && <> · reviewed by {a.reviewer.label}</>} · effective: <b>{a.effectiveRelationName}</b>
        {a.family && (
          <>
            {" "}
            · issue family <Hash value={a.family} />
          </>
        )}
      </div>
      {a.rationale ? (
        <p style={{ margin: "6px 0 0" }}>
          <span className="muted">Rationale:</span> {a.rationale}
        </p>
      ) : (
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Rationale withheld (digest <Hash value={a.rationaleDigest} />).
        </p>
      )}
      {a.reviews.map((rv, i) => (
        <p key={i} style={{ margin: "4px 0 0" }}>
          <span className="muted">{rv.approve ? "Confirmed" : "Rejected"} by {rv.reviewer}:</span> {rv.rationale ?? <>withheld (digest {short(rv.digest)})</>}
        </p>
      ))}
      {canReview && (
        <div className="form" style={{ marginTop: 8 }}>
          <Field label="Independent review rationale" htmlFor={`rv-${a.aid}`} hint="Only the other program's staff can review; the proposer cannot.">
            <textarea id={`rv-${a.aid}`} value={why} onChange={(e) => setWhy(e.target.value)} style={{ minHeight: 50 }} />
          </Field>
          <div className="row">
            <button className="btn quiet" disabled={!why.trim() || !!act.busy} onClick={() => act.run("rv", () => api.post(`/api/associations/${a.aid}/review`, { approve: true, rationale: why })).then((x) => x && reload())}>
              Confirm
            </button>
            <button className="btn quiet danger" disabled={!why.trim() || !!act.busy} onClick={() => act.run("rv", () => api.post(`/api/associations/${a.aid}/review`, { approve: false, rationale: why })).then((x) => x && reload())}>
              Reject
            </button>
          </div>
        </div>
      )}
      <ErrorNotice error={act.error} />
    </div>
  );
}

function OpenDispute({ kind, subject, label, reload }: { kind: number; subject: number; label: string; reload: () => void }) {
  const [text, setText] = useState("");
  const act = useAction();
  return (
    <details>
      <summary className="small">
        <Gavel size={14} aria-hidden="true" /> {label}
      </summary>
      <div className="form" style={{ marginTop: 8 }}>
        <Field label="Statement (sealed; visible to parties and eligible arbitrators)" htmlFor={`d-${kind}-${subject}`}>
          <textarea id={`d-${kind}-${subject}`} value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 60 }} />
        </Field>
        <button className="btn quiet" disabled={!text.trim() || !!act.busy} onClick={() => act.run("d", () => api.post<{ did: number }>("/api/disputes", { kind, subject, statement: text })).then((x) => (x ? navigate(`/disputes/${x.did}`) : reload()))}>
          Open dispute
        </button>
        <ErrorNotice error={act.error} />
        {act.message && <Notice kind="ok">{act.message}</Notice>}
      </div>
    </details>
  );
}

export function ReportDetail({ cid }: { cid: number }) {
  const { me, meta } = useSession();
  const { data: r, error, loading, reload } = useLoad(() => api.get<ReportView>(`/api/reports/${cid}`), [cid]);
  const act = useAction();
  const [grantTo, setGrantTo] = useState("");
  if (error) return <ErrorNotice error={error} />;
  if (loading && !r) return <Loading what="Loading report" />;
  if (!r) return null;
  const canReceipt = r.isOwner || r.isStaff || me?.kind === "auditor";
  return (
    <>
      <PageHead
        kicker={`${r.ref} · ${r.program.short} — ${r.program.name} (fictional)`}
        title={r.content ? r.content.title : `Commitment ${r.ref}`}
        lede={
          <span className="row">
            {r.supersededBy ? <StateStamp state="superseded" label={`replaced by ${ref(r.supersededBy)}`} /> : <StateStamp state={r.statusName} />}
            {r.mismatches > 0 && <StateStamp state="mismatch" label={`${r.mismatches} failed reveal check(s)`} />}
            {r.family && <StateStamp state="confirmed" label={`issue family ${short(r.family, 10)}`} />}
          </span>
        }
        actions={
          canReceipt && (
            <>
              <button className="btn" onClick={() => act.run("r", () => downloadJson(`/api/reports/${r.cid}/receipt`, "receipt.json"))}>
                <Download size={16} aria-hidden="true" /> Receipt
              </button>
              {r.isOwner && (
                <button className="btn" onClick={() => act.run("p", () => downloadJson(`/api/reports/${r.cid}/recovery`, "reveal-package.json"))}>
                  <Download size={16} aria-hidden="true" /> Private reveal package
                </button>
              )}
            </>
          )
        }
      />
      <ErrorNotice error={act.error} />
      <div className="grid-2">
        <div>
          <LedgerPanel title="Ledger record">
            <dl className="kv">
              <dt>Commitment</dt>
              <dd>
                <Hash value={r.commitment} full />
              </dd>
              <dt>Researcher</dt>
              <dd>
                {r.researcher.label} <span className="mono small">{r.researcher.address}</span>
              </dd>
              <dt>Program / policy</dt>
              <dd>
                {r.program.name} · policy v{r.policyVersion}
              </dd>
              <dt>Anchored</dt>
              <dd className="mono">{fmtTime(r.anchoredAt)}</dd>
              <dt>Transaction</dt>
              <dd>
                <Hash value={r.tx.hash} /> <span className="mono small">block {r.tx.blockNumber} · {r.tx.gasUsed} gas · log #{r.logSeq}</span>
              </dd>
              <dt>Reveal digest</dt>
              <dd>{r.revealDigest ? <Hash value={r.revealDigest} /> : <span className="muted">not yet verified</span>}</dd>
              {r.supersedes && (
                <>
                  <dt>Revises</dt>
                  <dd>
                    <Link to={`/reports/${r.supersedes}`}>{ref(r.supersedes)}</Link> (kept on record)
                  </dd>
                </>
              )}
              {r.supersededBy && (
                <>
                  <dt>Replaced by</dt>
                  <dd>
                    <Link to={`/reports/${r.supersededBy}`}>{ref(r.supersededBy)}</Link>
                  </dd>
                </>
              )}
            </dl>
            {canReceipt && (
              <div style={{ marginTop: 12 }}>
                <ReceiptCheck cid={r.cid} />
              </div>
            )}
          </LedgerPanel>

          {r.content ? (
            <Sealed title={`Report content — ${r.content.source}`} reason={r.access.reason}>
              {FIELDS.map(([k, label]) => (
                <div className="field-block" key={k}>
                  <div className="label">{label}</div>
                  <p>{String(r.content![k] ?? "")}</p>
                </div>
              ))}
              {r.content.privateNotes ? (
                <div className="field-block">
                  <div className="label">Private notes (yours only, not committed)</div>
                  <p>{r.content.privateNotes}</p>
                </div>
              ) : null}
              <div className="field-block">
                <div className="label">Evidence ({r.content.evidence.length} committed digest(s))</div>
                {r.content.evidenceFiles.length === 0 && r.content.evidence.length === 0 && <p className="muted">None.</p>}
                {r.content.evidenceFiles.map((e) => (
                  <p key={e.id} className="small">
                    <a href={`/api/evidence/${e.id}`}>{e.filename}</a> · {fmtBytes(e.size)} · <Hash value={e.sha256} /> {e.committed ? <Check ok>in commitment</Check> : <Check ok={false}>not in this reveal</Check>}
                  </p>
                ))}
              </div>
            </Sealed>
          ) : (
            <Withheld title="Report content" reason={r.access.reason} />
          )}

          <Sheet tab="Reveal checks" aside={`${r.reveals.length} on record`} flush>
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">Source</th>
                    <th scope="col">Pre-check</th>
                    <th scope="col">Recorded on-chain</th>
                  </tr>
                </thead>
                <tbody>
                  {r.reveals.map((x) => (
                    <tr key={x.id}>
                      <td className="mono">{x.id}</td>
                      <td className="mono small">{fmtTime(x.submitted_at)}</td>
                      <td className="small">{x.source}</td>
                      <td>
                        <StateStamp state={x.precheck} />
                      </td>
                      <td className="small">{x.outcome ? <><StateStamp state={x.outcome} /> by {x.verified_by} <Hash value={x.tx_hash} /></> : <span className="muted">awaiting program verification</span>}</td>
                    </tr>
                  ))}
                  {r.reveals.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        {r.isOwner || r.isStaff || me?.kind === "auditor" ? "Not revealed yet." : "Reveal records are visible to the researcher, the receiving program and auditors."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Sheet>

          <h2 style={{ margin: "8px 0 16px" }}>Ledger timeline</h2>
          <ol className="timeline">
            {r.timeline.map((e) => (
              <li className="entry" key={e.seq}>
                <span className="seq" aria-hidden="true">
                  #{e.seq}
                </span>
                <article className="slip">
                  <div className="slip-head">
                    <div>
                      <div className="type">{e.kindName}</div>
                      <div className="who">{e.actor.label}</div>
                    </div>
                    <span className="mono small">{fmtTime(e.at)}</span>
                  </div>
                  <div className="slip-foot small">
                    <span>
                      entry <Hash value={e.entryHash} /> · data <Hash value={e.dataHash} />
                    </span>
                    <span>
                      tx <Hash value={e.txHash} /> · block {e.blockNumber}
                    </span>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </div>

        <div>
          {r.isOwner && r.statusName === "reveal requested" && !r.supersededBy && <RevealPanel r={r} reload={reload} />}
          {r.isOwner && (
            <Sheet tab="Researcher actions">
              <div className="stack">
                {!r.supersededBy && r.statusName !== "finalized" && (
                  <Link className="btn quiet" to={`/researcher/new?revise=${r.cid}`}>
                    Revise this report (new commitment)
                  </Link>
                )}
                {r.status >= 4 && !r.supersededBy && (
                  <div className="row">
                    <label className="visually-hidden" htmlFor="rgrant">
                      Disclose to program
                    </label>
                    <select id="rgrant" value={grantTo} onChange={(e) => setGrantTo(e.target.value)} style={{ width: 220 }}>
                      <option value="">Disclose to another program…</option>
                      {meta?.programs.filter((p) => p.id !== r.program.id).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.short} — {p.name}
                        </option>
                      ))}
                    </select>
                    <button className="btn quiet" disabled={!grantTo || !!act.busy} onClick={() => act.run("g", () => api.post(`/api/reports/${r.cid}/grant`, { toProgram: Number(grantTo) })).then((x) => x && reload())}>
                      Grant
                    </button>
                  </div>
                )}
                {["valid", "invalid"].includes(r.statusName) && <OpenDispute kind={3} subject={r.cid} label="Dispute the triage result (validity)" reload={reload} />}
                {r.statusName === "anchored" && <p className="small muted">Waiting for {r.program.name} to acknowledge your commitment.</p>}
                {r.statusName === "acknowledged" && <p className="small muted">Acknowledged. You can reveal once the program requests it.</p>}
              </div>
            </Sheet>
          )}
          {r.isStaff && !r.supersededBy && <StaffActions r={r} reload={reload} />}
          {r.grants.length > 0 && (
            <Sheet tab="Disclosure grants (on-chain)">
              {r.grants.map((g) => (
                <p className="small" key={g.to_program} style={{ margin: 0 }}>
                  Readable by {meta?.programs.find((p) => p.id === g.to_program)?.name} staff — granted by {g.granted_by} <Hash value={g.tx_hash} />
                </p>
              ))}
            </Sheet>
          )}
          <Sheet tab="Cross-program associations">
            {r.associations.length === 0 && <p className="small muted">None.</p>}
            {r.associations.map((a) => (
              <div key={a.aid}>
                <AssociationCard a={a} reload={reload} />
                {(r.isOwner || r.isStaff) && ["confirmed", "rejected"].includes(a.statusName) && <OpenDispute kind={1} subject={a.aid} label={`Dispute this ${a.statusName} association`} reload={reload} />}
                {(r.isOwner || r.isStaff) && a.effectiveRelation === 1 && !r.disputes.some((d) => d.kind === 2 && d.subject === a.aid && d.statusName !== "final") && (
                  <OpenDispute kind={2} subject={a.aid} label="Dispute priority between these reports" reload={reload} />
                )}
              </div>
            ))}
          </Sheet>
          <Sheet tab="Disputes">
            {r.disputes.length === 0 && <p className="small muted">None.</p>}
            {r.disputes.map((d) => (
              <p key={d.did} className="small" style={{ margin: "0 0 6px" }}>
                <Link to={`/disputes/${d.did}`}>Dispute #{d.did}</Link> · {d.kindName} · <StateStamp state={d.statusName} /> {d.decisionName && <>· {d.decisionName}</>}
              </p>
            ))}
          </Sheet>
          {r.notes.length > 0 && (
            <Sealed title="Program review notes" reason={`Visible to ${r.program.name} staff only.`}>
              {r.notes.map((n) => (
                <div key={n.id} className="field-block">
                  <div className="label">
                    {n.author} · {fmtTime(n.createdAt)}
                  </div>
                  <p>{n.body}</p>
                </div>
              ))}
            </Sealed>
          )}
        </div>
      </div>
    </>
  );
}
