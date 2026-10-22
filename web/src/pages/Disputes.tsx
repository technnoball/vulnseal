import { api } from "../api.ts";
import { useIdentity } from "../identity.tsx";
import { Link } from "../router.tsx";
import { ErrorNotice, Loading, PageHead, Sheet, fmtTime, pad, useLoad } from "../ui.tsx";

interface Dispute {
  publicId: string;
  device: string;
  challengeSeq: number;
  targetSeq: number;
  targetTypeLabel: string;
  targetSummary: string;
  targetActor: { label: string } | null;
  challenger: { label: string; id: string };
  reason: string;
  evidenceCount: number;
  raisedAt: string;
  status: "open" | "resolved";
  resolution: { seq: number; outcome: string; outcomeLabel: string; reason: string; auditor: { label: string }; resolvedAt: string } | null;
}

export function Disputes() {
  const { actor } = useIdentity();
  const { data, error, loading } = useLoad(() => api.get<Dispute[]>("/api/disputes"), []);
  const open = data?.filter((d) => d.status === "open") ?? [];
  const closed = data?.filter((d) => d.status === "resolved") ?? [];
  return (
    <>
      <PageHead
        kicker="Section 04 · Dispute centre"
        title="Challenges and resolutions"
        lede="A challenge is appended against a claim; an independent auditor appends a resolution. Neither removes anything: the disputed claim, the challenge and the resolution all remain in the history."
      />
      <div className="grid-2">
        <div>
          <ErrorNotice error={error} />
          {loading && !data && <Loading />}
          {data && (
            <>
              <h2 style={{ marginBottom: 12 }}>Open ({open.length})</h2>
              {open.length === 0 && <p className="muted">No unresolved disputes.</p>}
              {open.map((d) => (
                <DisputeSlip key={d.publicId + d.challengeSeq} d={d} canResolve={!!actor?.roles.includes("AUDITOR")} />
              ))}
              <h2 style={{ margin: "24px 0 12px" }}>Resolved ({closed.length})</h2>
              {closed.length === 0 && <p className="muted">None yet.</p>}
              {closed.map((d) => (
                <DisputeSlip key={d.publicId + d.challengeSeq} d={d} canResolve={false} />
              ))}
            </>
          )}
        </div>
        <div>
          <Sheet tab="Rules enforced by the contract">
            <dl className="kv small">
              <dt>Challenge</dt>
              <dd>VERIFIER (buyer), INSPECTOR or REPAIRER — never the claim’s own author. One open challenge per claim.</dd>
              <dt>Resolve</dt>
              <dd>AUDITOR only. The author of the disputed claim and the challenger cannot resolve it, even if they hold the auditor role.</dd>
              <dt>Outcomes</dt>
              <dd>Claim upheld · claim rejected · inconclusive.</dd>
              <dt>History</dt>
              <dd>Nothing is deleted. A rejected claim stays visible with its outcome.</dd>
            </dl>
          </Sheet>
          <Sheet tab="Raise a challenge">
            <p className="small">
              Open a device passport and use <b>Challenge</b> on the record you dispute. Give a reason and, where possible, attach supporting evidence.
            </p>
            <Link className="btn" to="/devices">
              Choose a device
            </Link>
          </Sheet>
        </div>
      </div>
    </>
  );
}

function DisputeSlip({ d, canResolve }: { d: Dispute; canResolve: boolean }) {
  return (
    <article className={"slip"} style={{ marginBottom: 16, borderLeft: `6px solid ${d.status === "open" ? "var(--vermilion)" : "var(--slate)"}` }}>
      <div className="slip-head">
        <div>
          <div className="type">
            {d.device} <span className="mono small">{d.publicId}</span>
          </div>
          <div className="who">
            Challenge {pad(d.challengeSeq)} against {pad(d.targetSeq)} {d.targetTypeLabel} by {d.targetActor?.label}
          </div>
        </div>
        <span className={`stamp ${d.status === "open" ? "disputed" : "superseded"}`}>{d.status}</span>
      </div>
      <div className="slip-body">
        <div className="refline">
          <b>Disputed claim:</b> {d.targetSummary}
        </div>
        <p className="desc">
          <b>{d.challenger.label}:</b> {d.reason}
        </p>
        <div className="small muted">
          raised {fmtTime(d.raisedAt)}
          {d.evidenceCount ? ` · ${d.evidenceCount} evidence file(s)` : " · no evidence attached"}
        </div>
        {d.resolution && (
          <div className="well small">
            <b>{d.resolution.outcomeLabel}</b> — {d.resolution.auditor.label}, {fmtTime(d.resolution.resolvedAt)} (record {pad(d.resolution.seq)})
            <div>{d.resolution.reason}</div>
          </div>
        )}
      </div>
      <div className="slip-foot">
        <Link to={`/devices/${d.publicId}#rec-${d.challengeSeq}`}>View in passport</Link>
        {d.status === "open" && (
          <Link className={"btn " + (canResolve ? "primary" : "quiet")} to={`/devices/${d.publicId}/record?type=RESOLUTION&ref=${d.challengeSeq}`}>
            {canResolve ? "Resolve as auditor" : "Attempt resolution"}
          </Link>
        )}
      </div>
    </article>
  );
}
