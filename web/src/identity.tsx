// Demo identity selection. Stored per browser; sent as X-Demo-Actor.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setApiActor, type Identity, type Meta } from "./api.ts";

interface Ctx {
  meta: Meta | null;
  metaError: unknown;
  actor: Identity | null;
  setActor: (id: string) => void;
}
const IdentityCtx = createContext<Ctx>({ meta: null, metaError: null, actor: null, setActor: () => undefined });
const KEY = "patchledger.actor";

function readStored(): string {
  try {
    return localStorage.getItem(KEY) ?? "repairer-a";
  } catch {
    return "repairer-a";
  }
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<unknown>(null);
  const [actorId, setActorId] = useState<string>(() => {
    const id = readStored();
    setApiActor(id);
    return id;
  });
  useEffect(() => {
    api.get<Meta>("/api/meta").then(setMeta, setMetaError);
  }, []);
  const setActor = (id: string) => {
    setApiActor(id);
    setActorId(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* storage unavailable: selection lasts for this tab */
    }
  };
  const actor = meta?.identities.find((i) => i.id === actorId) ?? null;
  return <IdentityCtx.Provider value={{ meta, metaError, actor, setActor }}>{children}</IdentityCtx.Provider>;
}

export const useIdentity = () => useContext(IdentityCtx);

export function roleText(i: Identity | null) {
  if (!i) return "";
  return i.roles.length ? i.roles.join(" + ") : "NO ROLE";
}
