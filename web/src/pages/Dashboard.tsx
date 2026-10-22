import { api } from "../api.ts";
import { Link } from "../router.tsx";
import { ErrorNotice, Hash, Loading, Notice, PageHead, Sheet, fmtTime, pad, useLoad } from "../ui.tsx";

interface Dash {
  totals: { devices: number; repairEvents: number; claims: number; evidenceBacked: number; openDisputes: number; openConflicts: number; evidenceFiles: number };
  categoryCounts: Record<string, number>;
  chain: { devices: number; records: number; openDisputes: number; blockNumber: number; contract: string; chainId: number; rpcUrl: string } | null;
  chainError: string | null;
  recent: { publicId: string; device: string; seq: number; type: string; typeLabel: string; actor: { label: string }; recordedAt: string; summary: string; recordHash: string }[];
}

const CAT_ORDER: [string, string, string][] = [
  ["corroborated", "Independently corroborated", "var(--lichen)"],
  ["evidence-attached", "Evidence attached", "var(--brass)"],
  ["self-reported", "Self-reported", "var(--putty)"],
  ["superseded", "Corrected / superseded", "var(--slate)"],
  ["disputed", "Disputed", "var(--vermilion)"],
  ["evidence-failed", "Evidence integrity failed", "var(--umber)"],
];

export function Dashboard() {
  const { data, error, loading } = useLoad(() => api.get<Dash>("/api/dashboard"), []);
  return (
    <>
      <PageHead
        kicker="Section 01 · Ledger overview"
        title="Repair histories under audit"
        lede="Every figure below is computed from the off-chain record store and the PatchLedger contract running on the local development chain. All seeded devices, providers and documents are synthetic."
        actions={
          <>
            <Link className="btn" to="/devices">
              Open passports
            </Link>
            <Link className="btn primary" to="/devices/new">
              Register device
            </Link>
          </>
        }
      />
      <ErrorNotice error={error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          {data.chainError && <Notice kind="error" title="Ledger node unavailable.">{data.chainError}</Notice>}
          <div className="gauges" role="group" aria-label="Ledger totals">
            <div className="gauge">
              <div className="label">Registered laptops</div>
              <div className="value">{data.totals.devices}</div>
              <div className="note">{data.chain ? `${data.chain.devices} on-chain` : "chain not reachable"}</div>
            </div>
            <div className="gauge">
              <div className="label">Repair events</div>
              <div className="value">{data.totals.repairEvents}</div>
              <div className="note">diagnostic · repair · replacement</div>
            </div>
            <div className="gauge">
              <div className="label">Evidence-backed claims</div>
              <div className="value">{data.totals.evidenceBacked}</div>
              <div className="note">of {data.totals.claims} claims ({data.totals.evidenceFiles} files)</div>
            </div>
            <div className={"gauge" + (data.totals.openDisputes ? " alert" : "")}>
              <div className="label">Unresolved disputes</div>
              <div className="value">{data.totals.openDisputes}</div>
              <div className="note">{data.chain ? `contract reports ${data.chain.openDisputes}` : ""}</div>
            </div>
            <div className={"gauge" + (data.totals.openConflicts ? " alert" : "")}>
              <div className="label">Conflicting claims</div>
              <div className="value">{data.totals.openConflicts}</div>
              <div className="note">component lineage</div>
            </div>
          </div>

          <div className="grid-2">
            <Sheet tab="Recent ledger entries" aside={`${data.recent.length} latest`} flush>
              <div className="table-scroll">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">Recorded</th>
                      <th scope="col">Device</th>
                      <th scope="col">Record</th>
                      <th scope="col">Submitted by</th>
                      <th scope="col">Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => (
                      <tr key={r.publicId + r.seq}>
                        <td className="nowrap mono">{fmtTime(r.recordedAt)}</td>
                        <td>
                          <Link to={`/devices/${r.publicId}`}>{r.device}</Link>
                          <div className="mono small muted">{r.publicId}</div>
                        </td>
                        <td className="nowrap">
                          <span className="mono">{pad(r.seq)}</span> {r.typeLabel}
                        </td>
                        <td>{r.actor.label}</td>
                        <td className="small">{r.summary.length > 110 ? r.summary.slice(0, 110) + "…" : r.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Sheet>
            <div>
              <Sheet tab="Evidence status of claims">
                {(() => {
                  const total = Object.values(data.categoryCounts).reduce((a, b) => a + b, 0) || 1;
                  return (
                    <>
                      <div className="meter" role="img" aria-label={CAT_ORDER.map(([k, l]) => `${l}: ${data.categoryCounts[k] ?? 0}`).join(", ")}>
                        {CAT_ORDER.filter(([k]) => data.categoryCounts[k]).map(([k, l, c]) => (
                          <span key={k} title={`${l}: ${data.categoryCounts[k]}`} style={{ width: `${((data.categoryCounts[k] ?? 0) / total) * 100}%`, background: c }} />
                        ))}
                      </div>
                      <div className="legend">
                        {CAT_ORDER.map(([k, l, c]) => (
                          <span key={k}>
                            <i style={{ background: c }} />
                            {l} <span className="mono">{data.categoryCounts[k] ?? 0}</span>
                          </span>
                        ))}
                      </div>
                      <p className="small muted" style={{ marginTop: 12 }}>
                        Categories describe the evidence behind a claim, not whether it is true. A matching file digest shows the file is unchanged since submission.
                      </p>
                    </>
                  );
                })()}
              </Sheet>
              <Sheet tab="Ledger node">
                {data.chain ? (
                  <dl className="kv">
                    <dt>Network</dt>
                    <dd>Local Hardhat chain {data.chain.chainId}</dd>
                    <dt>RPC</dt>
                    <dd className="mono">{data.chain.rpcUrl}</dd>
                    <dt>Contract</dt>
                    <dd>
                      <Hash value={data.chain.contract} />
                    </dd>
                    <dt>Block height</dt>
                    <dd className="mono">{data.chain.blockNumber}</dd>
                    <dt>Records</dt>
                    <dd className="mono">{data.chain.records}</dd>
                  </dl>
                ) : (
                  <p className="muted">Not reachable.</p>
                )}
              </Sheet>
            </div>
          </div>
        </>
      )}
    </>
  );
}
