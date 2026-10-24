import { useState } from "react";
import { Gavel } from "lucide-react";
import { api, type AssociationView, type DisputeSummary, type LedgerEvent } from "../api.ts";
import { useSession } from "../identity.tsx";
import { Link } from "../router.tsx";
import { ErrorNotice, Field, Hash, LedgerPanel, Loading, Notice, PageHead, Sealed, Sheet, StateStamp, Withheld, fmtTime, useAction, useLoad } from "../ui.tsx";
import { AssociationCard } from "./ReportDetail.tsx";

interface DisputeView extends DisputeSummary {
  opener: { label: string; address: string };
  statement: string | null;
  statementDigest: string;
  firstDecision: number | null;
  firstDecisionName: string | null;
  firstReason: number | null;
  reversed: boolean;
  priorityTo: string | null;
  policy: { digest: string; programId: number; version: number | null; title: string | null };
  appealDeadline: string | null;
  appealOpen: boolean;
  threshold: number;
  viewerIsParty: boolean;
  viewerConflicted: boolean;
  association: AssociationView | null;
  acts: { act: string; round: number; actor: string; decision: number | null; decisionName: string | null; reasonCode: number | null; reason: string | null; digest: string | null; rationale: string | null; tx: string; at: string }[];
  timeline: LedgerEvent[];
}

export function DisputeDetail({ did }: { did: number }) {
  const { me, meta } = useSession();
  const { data: d, error, loading, reload } = useLoad(() => api.get<DisputeView>(`/api/disputes/${did}`), [did]);
  const act = useAction();
  const [vote, setVote] = useState({ decision: "", reasonCode: "", rationale: "" });
  const [appeal, setAppeal] = useState("");
  if (error) return <ErrorNotice error={error} />;
  if (loading && !d) return <Loading what="Loading dispute" />;
  if (!d) return null;
  const isArb = me?.kind === "arbitrator";
  const votingOpen = d.statusName === "open" || d.statusName === "appealed";
  const options = (meta?.decisionsForKind[String(d.kind)] ?? []).map((x) => [x, meta!.decisions[String(x)]] as const);
  const go = (label: string, fn: () => Promise<unknown>, ok: string) => act.run(label, fn, () => ok).then((x) => (x !== undefined ? reload() : undefined));
  const readable = d.statement !== null;
  return (
    <>
      <PageHead
        kicker={`Dispute #${d.did} · ${d.kindName} · ${d.programs.join(" vs ")}`}
        title={`${d.kindName[0].toUpperCase()}${d.kindName.slice(1)} dispute over ${d.refs.join(" and ")}`}
        lede={
          <span className="row">
            <StateStamp state={d.statusName} /> <span className="small">round {d.round} · {d.threshold} matching votes decide</span>
            {d.reversed && <StateStamp state="overturned" label="appeal changed the decision" />}
          </span>
        }
      />
      <ErrorNotice error={act.error} />
      {act.message && <Notice kind="ok">{act.message}</Notice>}
      <div className="grid-2">
        <div>
          <LedgerPanel title="Decision record">
            <dl className="kv">
              <dt>Reports</dt>
              <dd>
                {d.refs.map((r) => (
                  <Link key={r} to={`/reports/${Number(r.slice(3))}`} style={{ marginRight: 8 }}>
                    {r}
                  </Link>
                ))}
              </dd>
              <dt>Opened by</dt>
              <dd>
                {d.opener.label} · {fmtTime(d.openedAt)}
              </dd>
              <dt>Policy reference</dt>
              <dd>
                {d.policy.title ?? "policy"} {d.policy.version ? `(v${d.policy.version})` : ""} · <Hash value={d.policy.digest} />
              </dd>
              <dt>Round-1 decision</dt>
              <dd>{d.firstDecisionName ? `${d.firstDecisionName} — reason ${d.firstReason}: ${meta?.reasonCodes[String(d.firstReason)] ?? ""}` : "—"}</dd>
              <dt>Current decision</dt>
              <dd>{d.decisionName ? `${d.decisionName} — reason ${d.reasonCode}: ${meta?.reasonCodes[String(d.reasonCode)] ?? ""}` : "not decided"}</dd>
              {d.priorityTo && (
                <>
                  <dt>Priority to</dt>
                  <dd>{d.priorityTo}</dd>
                </>
              )}
              <dt>Decided</dt>
              <dd>{fmtTime(d.decidedAt)}</dd>
              <dt>Appeal</dt>
              <dd>
                {d.statusName === "appealed" ? "appeal under way (fresh panel)" : d.statusName === "final" ? (d.round === 2 ? "appeal decided — final" : "not appealed — final") : d.appealDeadline ? `possible until ${fmtTime(d.appealDeadline)}` : "after a decision"}
              </dd>
            </dl>
          </LedgerPanel>

          {readable ? (
            <Sealed title="Statement of the party who opened the dispute" reason="Visible to the parties and to eligible (unconflicted) arbitrators. Its salted digest is on-chain.">
              <p style={{ margin: 0 }}>{d.statement}</p>
            </Sealed>
          ) : (
            <Withheld title="Statement" reason={`Statements are visible to parties and eligible arbitrators. On-chain digest: ${d.statementDigest.slice(0, 18)}…`} />
          )}

          <Sheet tab="Votes, recusals and appeals (append-only)" flush>
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Round</th>
                    <th scope="col">Act</th>
                    <th scope="col">By</th>
                    <th scope="col">Decision / reason</th>
                    <th scope="col">Rationale</th>
                    <th scope="col">Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {d.acts.map((a, i) => (
                    <tr key={i}>
                      <td className="mono">{a.round}</td>
                      <td>{a.act}</td>
                      <td>{a.actor}</td>
                      <td className="small">{a.decisionName ? `${a.decisionName} (${a.reasonCode})` : "—"}</td>
                      <td className="small">{a.rationale ?? (a.digest ? <span className="muted">withheld · digest {a.digest.slice(0, 10)}…</span> : "—")}</td>
                      <td>
                        <Hash value={a.tx} />
                      </td>
                    </tr>
                  ))}
                  {d.acts.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No votes yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Sheet>
          {d.association && (
            <Sheet tab="Association under dispute">
              <AssociationCard a={d.association} reload={reload} />
            </Sheet>
          )}
        </div>

        <div>
          {me && votingOpen && (
            <Sheet tab={`Arbitration — round ${d.round}`} aside={me?.label}>
              {!isArb && (
                <Notice kind="warn" title="You are not a registered arbitrator.">
                  The form is shown so you can test the rule: the contract will reject a vote from {me.label}. Switch to an independent arbitrator (e.g. Holm or Okafor) to decide.
                </Notice>
              )}
              {d.viewerConflicted && (
                <Notice kind="warn" title="You are affiliated with an involved program.">
                  The contract will reject your vote. You can still submit to see the rejection, or recuse.
                </Notice>
              )}
              <div className="form">
                <Field label="Decision" htmlFor="dec">
                  <select id="dec" value={vote.decision} onChange={(e) => setVote({ ...vote, decision: e.target.value })}>
                    <option value="">— choose —</option>
                    {options.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reason code (clause of the shared policy)" htmlFor="reason">
                  <select id="reason" value={vote.reasonCode} onChange={(e) => setVote({ ...vote, reasonCode: e.target.value })}>
                    <option value="">— choose —</option>
                    {Object.entries(meta?.reasonCodes ?? {}).map(([c, label]) => (
                      <option key={c} value={c}>
                        {c} — {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reasoned decision (sealed; salted digest on-chain)" htmlFor="rat">
                  <textarea id="rat" value={vote.rationale} onChange={(e) => setVote({ ...vote, rationale: e.target.value })} />
                </Field>
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={!vote.decision || !vote.reasonCode || !vote.rationale.trim() || !!act.busy}
                    onClick={() => go("vote", () => api.post(`/api/disputes/${d.did}/vote`, { decision: Number(vote.decision), reasonCode: Number(vote.reasonCode), rationale: vote.rationale }), "Vote recorded on-chain.")}
                  >
                    <Gavel size={16} aria-hidden="true" /> Cast vote
                  </button>
                  <button className="btn quiet" disabled={!!act.busy} onClick={() => go("recuse", () => api.post(`/api/disputes/${d.did}/recuse`), "Recusal recorded on-chain.")}>
                    Recuse
                  </button>
                </div>
              </div>
            </Sheet>
          )}
          {d.viewerIsParty && d.statusName === "decided" && (
            <Sheet tab="Appeal">
              <p className="small">One appeal is allowed, within the appeal window. It is heard by arbitrators who did not decide round 1.</p>
              <Field label="Grounds for appeal (sealed)" htmlFor="appeal">
                <textarea id="appeal" value={appeal} onChange={(e) => setAppeal(e.target.value)} />
              </Field>
              <button className="btn" disabled={!appeal.trim() || !!act.busy} onClick={() => go("appeal", () => api.post(`/api/disputes/${d.did}/appeal`, { statement: appeal }), "Appeal recorded on-chain.")}>
                Appeal
              </button>
            </Sheet>
          )}
          {d.statusName === "decided" && (
            <Sheet tab="Close after the appeal window">
              <p className="small">Anyone may close an unappealed decision once the window has passed; before that, the contract refuses.</p>
              <button className="btn quiet" disabled={!!act.busy} onClick={() => go("close", () => api.post(`/api/disputes/${d.did}/close`), "Dispute closed — final.")}>
                Close dispute
              </button>
            </Sheet>
          )}
          <Sheet tab="Ledger events for this dispute">
            {d.timeline.map((e) => (
              <p key={e.seq} className="small" style={{ margin: "0 0 4px" }}>
                <span className="mono">#{e.seq}</span> {e.kindName} — {e.actor.label} · {fmtTime(e.at)}
              </p>
            ))}
          </Sheet>
        </div>
      </div>
    </>
  );
}
