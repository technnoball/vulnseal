import { Link } from "../router.tsx";
import { api, type LedgerEvent } from "../api.ts";
import { ErrorNotice, Hash, LedgerPanel, Loading, Notice, PageHead, Sheet, fmtTime, useLoad } from "../ui.tsx";

interface Dash {
  totals: Record<string, number>;
  chain: { contract: string; chainId: number; rpcUrl: string; blockNumber: number; logHead: string };
  recent: LedgerEvent[];
}

export function Overview() {
  const { data, error, loading } = useLoad(() => api.get<Dash>("/api/dashboard"), []);
  return (
    <>
      <PageHead
        kicker="VulnSeal · consortium overview"
        title="Shared commitment and arbitration ledger"
        lede="Three fictional bug bounty programs share one append-only ledger of report commitments, reveal checks, cross-program associations and arbitration decisions. Report contents never leave the off-chain vault. Every figure below is read from the contract and the local store."
        actions={
          <>
            <Link className="btn" to="/demo">
              Run the demo scenario
            </Link>
            <Link className="btn primary" to="/researcher/new">
              Commit a report
            </Link>
          </>
        }
      />
      <ErrorNotice error={error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="gauges" role="group" aria-label="Ledger totals">
            {[
              ["Researchers", data.totals.researchers, "registered pseudonyms"],
              ["Programs", data.totals.programs, "participating"],
              ["Commitments", data.totals.commitments, `${data.totals.revealed} revealed · ${data.totals.unrevealed} not`],
              ["Awaiting triage", data.totals.awaitingTriage, "revealed, undecided"],
              ["Open disputes", data.totals.openDisputes, `${data.totals.openCrossProgram} cross-program`],
              ["Arbitrations", data.totals.completedArbitrations, "completed (final)"],
            ].map(([label, value, note], i) => (
              <div className={"gauge" + (label === "Open disputes" && Number(value) > 0 ? " alert" : "")} key={i}>
                <div className="label">{label}</div>
                <div className="value">{value}</div>
                <div className="note">{note}</div>
              </div>
            ))}
          </div>
          <div className="grid-2">
            <Sheet tab="Recent ledger events" aside={`${data.totals.logEntries} entries in total`} flush>
              <div className="table-scroll">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Event</th>
                      <th scope="col">Subject</th>
                      <th scope="col">Actor (pseudonym)</th>
                      <th scope="col">Block time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((e) => (
                      <tr key={e.seq}>
                        <td className="mono">{e.seq}</td>
                        <td>{e.kindName}</td>
                        <td className="mono small">{e.subject}</td>
                        <td>{e.actor.label}</td>
                        <td className="mono small nowrap">{fmtTime(e.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Sheet>
            <div>
              <LedgerPanel title="Ledger node">
                <dl className="kv">
                  <dt>Network</dt>
                  <dd>Local Hardhat chain {data.chain.chainId} (single node)</dd>
                  <dt>RPC</dt>
                  <dd className="mono">{data.chain.rpcUrl}</dd>
                  <dt>Contract</dt>
                  <dd>
                    <Hash value={data.chain.contract} />
                  </dd>
                  <dt>Block</dt>
                  <dd className="mono">{data.chain.blockNumber}</dd>
                  <dt>Log head</dt>
                  <dd>
                    <Hash value={data.chain.logHead} />
                  </dd>
                </dl>
              </LedgerPanel>
              <Notice title="What the ledger shows.">
                Who committed what hash, to which program, when; reveal check outcomes; who proposed and reviewed associations; who voted how in arbitration. It does not show report text, evidence or nonces,
                and it cannot show that any report is true.
              </Notice>
            </div>
          </div>
        </>
      )}
    </>
  );
}
