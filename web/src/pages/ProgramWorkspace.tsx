import { api, type AssociationView, type Program } from "../api.ts";
import { useSession } from "../identity.tsx";
import { Link } from "../router.tsx";
import { ErrorNotice, Hash, Loading, Notice, PageHead, Sheet, StateStamp, fmtTime, useLoad } from "../ui.tsx";
import { AssociationCard } from "./ReportDetail.tsx";

interface Inbox {
  programId: number;
  program: Program;
  items: { cid: number; ref: string; researcher: { label: string }; statusName: string; anchoredAt: string; mismatches: number; supersededBy: number | null; title: string | null; reveals: any[]; pendingVerification: number[] }[];
  disclosed: number[];
}

const NEXT: Record<string, string> = {
  anchored: "Acknowledge",
  acknowledged: "Request reveal",
  "reveal requested": "Waiting for the researcher to reveal",
  revealed: "Start triage",
  "pending triage": "Decide: valid / invalid / needs info",
  "needs info": "Waiting for more information",
  valid: "Record final disposition",
  invalid: "Record final disposition",
  finalized: "—",
};

export function ProgramWorkspace() {
  const { me } = useSession();
  const staff = me?.kind === "program-admin" || me?.kind === "reviewer";
  const inbox = useLoad(() => (staff ? api.get<Inbox>("/api/program/inbox") : Promise.resolve(null)), [staff]);
  const explorer = useLoad(() => (staff ? api.get<any>("/api/explorer") : Promise.resolve(null)), [staff]);
  const programs = useLoad(() => api.get<any[]>("/api/programs"), []);
  const pendingAssoc = (explorer.data?.associations ?? []).filter((a: any) => a.statusName === "proposed");
  const assocViews = useLoad(
    () => (staff ? Promise.all(pendingAssoc.map((a: any) => api.get<AssociationView>(`/api/associations/${a.aid}`))) : Promise.resolve([])),
    [staff, pendingAssoc.map((a: any) => a.aid).join(",")],
  );
  const mine = programs.data?.find((p) => p.id === me?.programId);
  return (
    <>
      <PageHead
        kicker={inbox.data ? `${inbox.data.program.short} — ${inbox.data.program.name} (fictional)` : "Program workspace"}
        title="Submissions addressed to this program"
        lede="Commitments arrive as hashes. You see a report's content only after the researcher reveals it to you, or when another program's report is disclosed to you on-chain."
      />
      {!staff && (
        <Notice kind="warn" title="Sign in as program staff.">
          Choose a program administrator or triage reviewer (Ashgrove, Kestrel or Tamarind) in the identity selector.
        </Notice>
      )}
      <ErrorNotice error={inbox.error} />
      {staff && inbox.loading && !inbox.data && <Loading />}
      {inbox.data && (
        <div className="grid-2">
          <div>
            <Sheet tab="Inbox" aside={`${inbox.data.items.length} submissions`} flush>
              <div className="table-scroll">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">Report</th>
                      <th scope="col">Researcher</th>
                      <th scope="col">Title</th>
                      <th scope="col">Status</th>
                      <th scope="col">Next step</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inbox.data.items.map((i) => (
                      <tr key={i.cid}>
                        <td className="mono nowrap">
                          <Link to={`/reports/${i.cid}`}>{i.ref}</Link>
                          <div className="small muted">{fmtTime(i.anchoredAt)}</div>
                        </td>
                        <td>{i.researcher.label}</td>
                        <td className="small">{i.title ?? <span className="muted">sealed until revealed</span>}</td>
                        <td>
                          {i.supersededBy ? <StateStamp state="superseded" /> : <StateStamp state={i.statusName} />}
                          {i.mismatches > 0 && <div className="small" style={{ color: "var(--vermilion-ink)" }}>{i.mismatches} mismatch(es)</div>}
                        </td>
                        <td className="small">{i.pendingVerification.length ? <b>Verify reveal #{i.pendingVerification.join(", #")}</b> : i.supersededBy ? "Replaced by a revision" : NEXT[i.statusName]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Sheet>
            {inbox.data.disclosed.length > 0 && (
              <Sheet tab="Disclosed to your program by others">
                {inbox.data.disclosed.map((cid) => (
                  <Link key={cid} to={`/reports/${cid}`} className="btn quiet" style={{ marginRight: 8 }}>
                    VS-{String(cid).padStart(4, "0")}
                  </Link>
                ))}
              </Sheet>
            )}
          </div>
          <div>
            <Sheet tab="Associations awaiting independent review">
              {(assocViews.data ?? []).length === 0 && <p className="small muted">None.</p>}
              {(assocViews.data ?? []).map((a) => (
                <AssociationCard key={a.aid} a={a} reload={() => (assocViews.reload(), explorer.reload())} />
              ))}
            </Sheet>
            {mine && (
              <Sheet tab="Policy versions (text off-chain, digest on-chain)">
                {mine.policies.map((p: any) => (
                  <details key={p.version}>
                    <summary className="small">
                      v{p.version} {p.version === mine.policyVersion ? "(current)" : ""} · <Hash value={p.digest} />
                    </summary>
                    <pre className="log" style={{ marginTop: 6 }}>
                      {p.body}
                    </pre>
                  </details>
                ))}
              </Sheet>
            )}
          </div>
        </div>
      )}
    </>
  );
}
