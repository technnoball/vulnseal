import { Play, RotateCcw } from "lucide-react";
import { api } from "../api.ts";
import { Link } from "../router.tsx";
import { Check, ErrorNotice, Hash, Loading, Notice, PageHead, Sheet, fmtTime, useAction, useLoad } from "../ui.tsx";

interface DemoState {
  steps: string[];
  next: number;
  run: number;
  done: boolean;
  cidA?: number;
  cidC?: number;
  did?: number;
  refs: { a: string | null; c: string | null };
  results: { step: number; title: string; at: string; actions: { label: string; actor: string; ok: boolean; expectedFailure?: boolean; tx?: string; detail?: string }[] }[];
}

export function Demo() {
  const { data, error, loading, reload } = useLoad(() => api.get<DemoState>("/api/demo"), []);
  const act = useAction();
  const step = () => act.run("step", () => api.post("/api/demo/step")).then(() => reload());
  const reset = () => act.run("reset", () => api.post("/api/demo/reset")).then(() => reload());
  return (
    <>
      <PageHead
        kicker="Demonstration mode · fictional scenario"
        title="From first commitment to final adjudication"
        lede="Each step performs real actions: contract transactions signed by the named fictional identities, reveal checks and access-controlled reads. Expected rejections come from the contract itself. Nothing is pre-recorded."
        actions={
          data && (
            <>
              <button className="btn primary" onClick={step} disabled={data.done || !!act.busy}>
                <Play size={16} aria-hidden="true" /> {act.busy === "step" ? "Running…" : data.done ? "Scenario complete" : `Run step ${data.next + 1}`}
              </button>
              <button className="btn" onClick={reset} disabled={!!act.busy}>
                <RotateCcw size={16} aria-hidden="true" /> Start again
              </button>
            </>
          )
        }
      />
      <ErrorNotice error={error || act.error} />
      {loading && !data && <Loading />}
      {data && (
        <div className="grid-2">
          <Sheet tab={`Scenario run ${data.run}`} aside={`${data.results.length} / ${data.steps.length} steps`}>
            <ol className="steps">
              {data.steps.map((title, i) => {
                const r = data.results.find((x) => x.step === i);
                return (
                  <li key={i} className={r ? "done" : i === data.next ? "next" : ""}>
                    <div className="step-title">{title}</div>
                    {r && (
                      <div>
                        {r.actions.map((a, j) => (
                          <div className="act" key={j}>
                            <Check ok={a.ok ? true : a.expectedFailure ? null : false}>{a.ok ? "ok" : a.expectedFailure ? "rejected as expected" : "failed"}</Check>
                            <span>
                              <b>{a.actor}</b>: {a.label}
                              {a.detail && <span className="muted"> — {a.detail}</span>}
                              {a.tx && (
                                <>
                                  {" "}
                                  · tx <Hash value={a.tx} />
                                </>
                              )}
                            </span>
                          </div>
                        ))}
                        <div className="small muted">{fmtTime(r.at)}</div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </Sheet>
          <div>
            <Notice title="Inspect the result yourself.">
              {data.cidA ? (
                <>
                  Open <Link to={`/reports/${data.cidA}`}>{data.refs.a}</Link>
                  {data.cidC && (
                    <>
                      {" "}
                      and <Link to={`/reports/${data.cidC}`}>{data.refs.c}</Link>
                    </>
                  )}
                  {data.did && (
                    <>
                      , or <Link to={`/disputes/${data.did}`}>dispute #{data.did}</Link>
                    </>
                  )}
                  . Switch identities to see what each participant may read.
                </>
              ) : (
                "Run the first step to create the scenario's reports."
              )}
            </Notice>
            <Notice kind="warn" title="Starting again">
              creates new reports. Earlier runs stay on the ledger, because nothing can be deleted from it.
            </Notice>
          </div>
        </div>
      )}
    </>
  );
}
