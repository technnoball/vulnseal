// Simulated sign-in: choosing a demo identity asks the server for a signed session cookie.
// It is a convenience for local evaluation, not authentication.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Identity, type Meta } from "./api.ts";

interface Ctx {
  meta: Meta | null;
  metaError: unknown;
  me: Identity | null;
  ready: boolean;
  signIn: (id: string) => Promise<void>;
  version: number; // bumps on identity change so pages reload
}
const SessionCtx = createContext<Ctx>({ meta: null, metaError: null, me: null, ready: false, signIn: async () => undefined, version: 0 });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<unknown>(null);
  const [me, setMe] = useState<Identity | null>(null);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api.get<Meta>("/api/meta").then(setMeta, setMetaError);
    api
      .get<{ identity: Identity | null }>("/api/session")
      .then((s) => setMe(s.identity))
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);
  const signIn = useCallback(async (id: string) => {
    const s = await api.post<{ identity: Identity }>("/api/session", { identityId: id });
    setMe(s.identity);
    setVersion((v) => v + 1);
  }, []);
  return <SessionCtx.Provider value={{ meta, metaError, me, ready, signIn, version }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);

export const KIND_LABEL: Record<string, string> = {
  governor: "Consortium desk",
  researcher: "Security researcher",
  "program-admin": "Program administrator",
  reviewer: "Triage reviewer",
  arbitrator: "Independent arbitrator",
  auditor: "Auditor (read-only)",
  outsider: "Unregistered visitor",
};
