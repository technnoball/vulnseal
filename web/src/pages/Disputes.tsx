import { Scale } from "lucide-react";
import { api, type DisputeSummary } from "../api.ts";
import { Link } from "../router.tsx";
import { ErrorNotice, Loading, Notice, PageHead, Sheet, StateStamp, fmtTime, useLoad } from "../ui.tsx";

export function Disputes() {
  const { data, error, loading } = useLoad(() => api.get<DisputeSummary[]>("/api/disputes"), []);
  return (
    <>
      <PageHead
        kicker="Dispute and arbitration centre"
        title="Disputes about relationships, priority and validity"
        lede="Parties open disputes; independent arbitrators decide by a 2-vote threshold; one appeal is heard by a fresh panel. Nothing is overwritten: the claims, the first decision and the appeal stay on the ledger."
      />
      <ErrorNotice error={error} />
      {loading && !data && <Loading />}
      <div className="grid-2">
        <Sheet tab="All disputes" flush>
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Dispute</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Reports</th>
                  <th scope="col">Programs</th>
                  <th scope="col">Status</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Opened</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((d) => (
                  <tr key={d.did}>
                    <td className="mono">
                      <Link to={`/disputes/${d.did}`}>#{d.did}</Link>
                    </td>
                    <td>{d.kindName}</td>
                    <td className="mono small">{d.refs.join(" · ")}</td>
                    <td className="small">{d.programs.join(", ")}</td>
                    <td>
                      <StateStamp state={d.statusName} /> <span className="small muted">round {d.round}</span>
                    </td>
                    <td className="small">{d.decisionName ?? "—"}</td>
                    <td className="mono small nowrap">{fmtTime(d.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Sheet>
        <div>
          <Sheet tab="Rules enforced by the contract">
            <dl className="kv small">
              <dt>Open</dt>
              <dd>A researcher whose report is involved, or staff of an involved program. One live dispute per subject.</dd>
              <dt>Decide</dt>
              <dd>Registered arbitrators only. Two matching votes (decision and reason code) decide. One vote per address per round.</dd>
              <dt>Recusal</dt>
              <dd>An arbitrator affiliated with an involved program cannot vote; any arbitrator may recuse.</dd>
              <dt>Appeal</dt>
              <dd>Once, by a party, within the appeal window. Round-1 arbitrators cannot sit on the appeal.</dd>
              <dt>Final</dt>
              <dd>After the appeal decision, or when the window closes unappealed. Both rounds remain recorded.</dd>
            </dl>
          </Sheet>
          <Notice title="Starting a dispute.">
            <Scale size={14} aria-hidden="true" /> Open a report you are a party to and use the dispute actions under its associations or triage result.
          </Notice>
        </div>
      </div>
    </>
  );
}
