import { FilePlus2 } from "lucide-react";
import { api, type Program } from "../api.ts";
import { useSession } from "../identity.tsx";
import { Link } from "../router.tsx";
import { ErrorNotice, Loading, Notice, PageHead, Sealed, Sheet, StateStamp, fmtTime, short, useLoad } from "../ui.tsx";

interface Mine {
  reports: { cid: number; ref: string; title: string; program: Program; statusName: string; anchoredAt: string; mismatches: number; supersededBy: number | null; supersedes: number | null; family: string | null }[];
  pendingEvidence: { id: string; filename: string; sha256: string }[];
  privateIdentity: Record<string, string> | null;
}

export function ResearcherWorkspace() {
  const { me } = useSession();
  const isResearcher = me?.kind === "researcher";
  const { data, error, loading } = useLoad(() => (isResearcher ? api.get<Mine>("/api/me/reports") : Promise.resolve(null)), [isResearcher]);
  return (
    <>
      <PageHead
        kicker="Researcher workspace"
        title={isResearcher ? `Reports of ${me!.label}` : "Researcher workspace"}
        lede="Write a confidential report, commit to it on the shared ledger, keep the receipt and the private reveal package, and reveal the report when the program asks."
        actions={
          isResearcher && (
            <Link className="btn primary" to="/researcher/new">
              <FilePlus2 size={16} aria-hidden="true" /> New confidential report
            </Link>
          )
        }
      />
      {!isResearcher && (
        <Notice kind="warn" title="Sign in as a researcher.">
          Choose basalt, quillfox or nightjar in the identity selector at the top. Reports are only ever shown to the researcher who wrote them, and to programs after a reveal.
        </Notice>
      )}
      <ErrorNotice error={error} />
      {isResearcher && loading && !data && <Loading />}
      {data && (
        <div className="grid-2">
          <Sheet tab="Your committed reports" aside={`${data.reports.length} reports`} flush>
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Report</th>
                    <th scope="col">Title (private)</th>
                    <th scope="col">Program</th>
                    <th scope="col">Status</th>
                    <th scope="col">Anchored</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reports.map((r) => (
                    <tr key={r.cid}>
                      <td className="mono nowrap">
                        <Link to={`/reports/${r.cid}`}>{r.ref}</Link>
                      </td>
                      <td>
                        {r.title}
                        {r.supersedes && <div className="small muted">revision of VS-{String(r.supersedes).padStart(4, "0")}</div>}
                        {r.family && <div className="small muted">issue family {short(r.family, 12)}</div>}
                      </td>
                      <td>{r.program.short}</td>
                      <td>
                        {r.supersededBy ? <StateStamp state="superseded" label={`replaced by VS-${String(r.supersededBy).padStart(4, "0")}`} /> : <StateStamp state={r.statusName} />}
                        {r.mismatches > 0 && <div className="small" style={{ color: "var(--vermilion-ink)" }}>{r.mismatches} failed reveal check(s) on record</div>}
                      </td>
                      <td className="mono small nowrap">{fmtTime(r.anchoredAt)}</td>
                    </tr>
                  ))}
                  {data.reports.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No reports yet. <Link to="/researcher/new">Commit your first report</Link>.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Sheet>
          <div>
            {data.privateIdentity && (
              <Sealed title="Private identity mapping" reason="Only you see this. The ledger knows you only by your pseudonymous address.">
                <dl className="kv">
                  {Object.entries(data.privateIdentity).map(([k, v]) => (
                    <div key={k} style={{ display: "contents" }}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                  <dt>Address</dt>
                  <dd className="mono small">{me!.address}</dd>
                </dl>
              </Sealed>
            )}
            <Notice title="Your receipt proves:">
              that this exact commitment was recorded by your pseudonymous address for a program and policy version, before every later ledger entry. <strong>It does not prove</strong> that the report is true,
              valid, original, or when you discovered the issue.
            </Notice>
          </div>
        </div>
      )}
    </>
  );
}
