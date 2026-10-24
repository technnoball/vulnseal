import { useEffect, useState, type ReactNode } from "react";
import { ClipboardCheck, FlaskConical, Inbox, LayoutDashboard, Network, Play, Receipt, Scale, UserRound } from "lucide-react";
import { KIND_LABEL, useSession } from "./identity.tsx";
import { Link, match, useLocation } from "./router.tsx";
import { ErrorNotice, Notice } from "./ui.tsx";
import { Overview } from "./pages/Overview.tsx";
import { ResearcherWorkspace } from "./pages/ResearcherWorkspace.tsx";
import { NewReport } from "./pages/NewReport.tsx";
import { ReportDetail } from "./pages/ReportDetail.tsx";
import { ProgramWorkspace } from "./pages/ProgramWorkspace.tsx";
import { Explorer } from "./pages/Explorer.tsx";
import { Disputes } from "./pages/Disputes.tsx";
import { DisputeDetail } from "./pages/DisputeDetail.tsx";
import { Audit } from "./pages/Audit.tsx";
import { VerifyReceipt } from "./pages/VerifyReceipt.tsx";
import { Demo } from "./pages/Demo.tsx";
import { Research } from "./pages/Research.tsx";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/researcher", label: "Researcher workspace", icon: UserRound },
  { to: "/program", label: "Program workspace", icon: Inbox },
  { to: "/explorer", label: "Cross-program explorer", icon: Network },
  { to: "/disputes", label: "Disputes & arbitration", icon: Scale },
  { to: "/audit", label: "Audit & verification", icon: ClipboardCheck },
  { to: "/verify", label: "Receipt verifier", icon: Receipt },
  { to: "/demo", label: "Demo scenario", icon: Play },
  { to: "/research", label: "Research benchmark", icon: FlaskConical },
];

function route(path: string): { el: ReactNode; crumb: string } {
  let m;
  if (path === "/") return { el: <Overview />, crumb: "Overview" };
  if (path === "/researcher") return { el: <ResearcherWorkspace />, crumb: "Researcher workspace" };
  if (path === "/researcher/new") return { el: <NewReport />, crumb: "Researcher workspace / New report" };
  if ((m = match("/reports/:cid", path))) return { el: <ReportDetail cid={Number(m.cid)} />, crumb: `Report VS-${m.cid.padStart(4, "0")}` };
  if (path === "/program") return { el: <ProgramWorkspace />, crumb: "Program workspace" };
  if (path === "/explorer") return { el: <Explorer />, crumb: "Cross-program explorer" };
  if (path === "/disputes") return { el: <Disputes />, crumb: "Disputes & arbitration" };
  if ((m = match("/disputes/:did", path))) return { el: <DisputeDetail did={Number(m.did)} />, crumb: `Dispute #${m.did}` };
  if (path === "/audit") return { el: <Audit />, crumb: "Audit & verification" };
  if (path === "/verify") return { el: <VerifyReceipt />, crumb: "Receipt verifier" };
  if (path === "/demo") return { el: <Demo />, crumb: "Demo scenario" };
  if (path === "/research") return { el: <Research />, crumb: "Research benchmark" };
  return {
    el: (
      <Notice kind="warn" title="Not found.">
        No page at {path}. <Link to="/">Return to the overview</Link>.
      </Notice>
    ),
    crumb: "Not found",
  };
}

function ChainStatus() {
  const [h, setH] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((d) => alive && setH(d))
        .catch(() => alive && setH({ ok: false, chain: { error: "API unreachable" } }));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!h) return <div className="rail-foot">checking ledger node…</div>;
  return (
    <div className="rail-foot" role="status" aria-live="polite">
      <div>
        <span className={"dot" + (h.ok ? "" : " down")} aria-hidden="true" />
        {h.ok ? `chain ${h.chain.chainId} · block ${h.chain.blockNumber}` : "ledger node unavailable"}
      </div>
      {h.ok ? <div title={h.chain.contract}>contract {h.chain.contract.slice(0, 8)}…{h.chain.contract.slice(-4)}</div> : <div>{h.chain?.error?.slice(0, 80)}</div>}
      <div>local only · 127.0.0.1</div>
    </div>
  );
}

function IdentitySwitch() {
  const { meta, me, signIn } = useSession();
  const [err, setErr] = useState<unknown>(null);
  if (!meta) return null;
  const groups = ["researcher", "program-admin", "reviewer", "arbitrator", "auditor", "governor", "outsider"];
  return (
    <div className="actor-switch">
      <label htmlFor="identity">Signed in as</label>
      <select
        id="identity"
        value={me?.id ?? ""}
        onChange={(e) => signIn(e.target.value).catch(setErr)}
        aria-describedby="identity-role identity-sim"
      >
        {!me && <option value="">— choose a demo identity —</option>}
        {groups.map((g) => (
          <optgroup key={g} label={KIND_LABEL[g]}>
            {meta.identities
              .filter((i) => i.kind === g)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                  {i.programName ? ` — ${i.programName}` : ""}
                  {i.note ? ` (${i.note})` : ""}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {me && (
        <span className="role-chip" id="identity-role" title={me.address}>
          {KIND_LABEL[me.kind]}
        </span>
      )}
      <span className="sim-tag" id="identity-sim" title="Choosing an identity issues a signed demo session cookie. There is no password: this simulates sign-in for local evaluation and is not real authentication.">
        simulated sign-in
      </span>
      {err ? <ErrorNotice error={err} /> : null}
    </div>
  );
}

export function App() {
  const { path } = useLocation();
  const { metaError } = useSession();
  const r = route(path);
  useEffect(() => {
    document.title = `${r.crumb.split(" / ")[0]} · VulnSeal`;
  }, [r.crumb]);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="rail">
        <div className="rail-brand">
          <Link to="/" className="wordmark">
            VulnSeal
          </Link>
          <div className="sub">Report commitments · cross-program arbitration · research prototype</div>
        </div>
        <nav aria-label="Primary">
          {NAV.map((n) => {
            const active = n.to === "/" ? path === "/" : path === n.to || path.startsWith(n.to + "/") || (n.to === "/researcher" && path.startsWith("/reports/"));
            const Icon = n.icon;
            return (
              <Link key={n.to} to={n.to} aria-current={active ? "page" : undefined}>
                <span className="ico">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <span>{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <ChainStatus />
      </aside>
      <div className="main">
        <div className="topbar">
          <span className="crumb">{r.crumb}</span>
          <IdentitySwitch />
        </div>
        <main className="content" id="main" tabIndex={-1}>
          {metaError ? (
            <Notice kind="error" title="Cannot reach the VulnSeal API.">
              {String((metaError as Error).message)}
            </Notice>
          ) : null}
          {r.el}
        </main>
      </div>
    </div>
  );
}
