import { useState } from "react";
import { api } from "../api.ts";
import { Link } from "../router.tsx";
import { ErrorNotice, Hash, Loading, Notice, PageHead, Sheet, StateStamp, fmtTime, short, useLoad } from "../ui.tsx";

export function Explorer() {
  const { data, error, loading } = useLoad(() => api.get<any>("/api/explorer"), []);
  const [prog, setProg] = useState("all");
  const rows = (data?.commitments ?? []).filter((c: any) => prog === "all" || c.program === prog);
  return (
    <>
      <PageHead
        kicker="Cross-program case explorer"
        title="Claims across participating programs"
        lede="Everything on this page is visible to every consortium participant: pseudonymous addresses, commitment hashes, times, states and relationships. No report text or evidence appears here, whoever you are signed in as."
      />
      <ErrorNotice error={error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Notice kind="warn" title="Metadata still leaks.">
            Even without content, the ledger shows that a pseudonym submitted to a program at a certain time, and an issue-family token shows that two submissions were judged related.
          </Notice>
          <Sheet tab="Commitments" aside={
            <span className="row">
              <label htmlFor="pf" className="visually-hidden">Filter by program</label>
              <select id="pf" value={prog} onChange={(e) => setProg(e.target.value)} style={{ width: 160, padding: "2px 6px" }}>
                <option value="all">All programs</option>
                <option>Program A</option>
                <option>Program B</option>
                <option>Program C</option>
              </select>
            </span>
          } flush>
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Report</th>
                    <th scope="col">Program</th>
                    <th scope="col">Researcher (pseudonym)</th>
                    <th scope="col">Commitment</th>
                    <th scope="col">Anchored</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reveal verification</th>
                    <th scope="col">Issue family</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c: any) => (
                    <tr key={c.cid}>
                      <td className="mono nowrap">
                        <Link to={`/reports/${c.cid}`}>{c.ref}</Link>
                        {c.supersedes && <div className="small muted">revises VS-{String(c.supersedes).padStart(4, "0")}</div>}
                      </td>
                      <td>{c.program}</td>
                      <td>
                        {c.researcher.label} <span className="mono small muted">{short(c.researcher.address, 8)}</span>
                      </td>
                      <td>
                        <Hash value={c.commitment} />
                      </td>
                      <td className="mono small nowrap">{fmtTime(c.anchoredAt)}</td>
                      <td>{c.supersededBy ? <StateStamp state="superseded" /> : <StateStamp state={c.statusName} />}</td>
                      <td className="small">
                        <StateStamp state={c.revealState.startsWith("verified") ? "match" : c.revealState.includes("failed") ? "mismatch" : "not revealed"} label={c.revealState} />
                      </td>
                      <td>{c.family ? <Hash value={c.family} /> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sheet>
          <div className="grid-halves">
            <Sheet tab="Associations" flush>
              <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Reports</th>
                    <th scope="col">Proposed</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reviewed by</th>
                  </tr>
                </thead>
                <tbody>
                  {data.associations.map((a: any) => (
                    <tr key={a.aid}>
                      <td className="mono">{a.aid}</td>
                      <td className="mono small">
                        {a.refA} ↔ {a.refB}
                      </td>
                      <td className="small">
                        {a.relationName} <div className="muted">by {a.proposer}</div>
                      </td>
                      <td>
                        <StateStamp state={a.statusName} />
                        {a.decidedRelationName && <div className="small muted">decided: {a.decidedRelationName}</div>}
                      </td>
                      <td className="small">{a.reviewer ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Sheet>
            <Sheet tab="Disputes" flush>
              <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Reports</th>
                    <th scope="col">Status</th>
                    <th scope="col">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {data.disputes.map((d: any) => (
                    <tr key={d.did}>
                      <td className="mono">
                        <Link to={`/disputes/${d.did}`}>{d.did}</Link>
                      </td>
                      <td>{d.kindName}</td>
                      <td className="mono small">{d.refs.join(" · ")}</td>
                      <td>
                        <StateStamp state={d.statusName} /> <span className="small muted">round {d.round}</span>
                      </td>
                      <td className="small">{d.decisionName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Sheet>
          </div>
        </>
      )}
    </>
  );
}
