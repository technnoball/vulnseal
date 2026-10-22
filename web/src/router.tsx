// Minimal history-API router (avoids a routing dependency).
import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

type Loc = { path: string; search: URLSearchParams };
const read = (): Loc => ({ path: window.location.pathname, search: new URLSearchParams(window.location.search) });
const RouterCtx = createContext<Loc>(read());

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState<Loc>(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return <RouterCtx.Provider value={loc}>{children}</RouterCtx.Provider>;
}

export const useLocation = () => useContext(RouterCtx);

/** Match "/devices/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) out[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
