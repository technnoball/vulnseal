// Demo sessions. Picking an identity in the UI issues an HMAC-signed cookie for it.
// There is no password: this simulates authentication, it does not provide it.
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { identityDef } from "./domain.ts";

export const SESSION_COOKIE = "vs_session";

export class Sessions {
  private secret: Buffer;
  constructor(secret: Buffer) {
    this.secret = secret;
  }
  static open(keyDir: string): Sessions {
    const p = path.join(keyDir, "session.key");
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(p)) fs.writeFileSync(p, randomBytes(32), { mode: 0o600, flag: "wx" });
    return new Sessions(fs.readFileSync(p));
  }
  issue(identityId: string): string {
    const body = `${identityId}.${Date.now()}`;
    return `${body}.${this.mac(body)}`;
  }
  verify(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const i = token.lastIndexOf(".");
    if (i < 0) return undefined;
    const body = token.slice(0, i);
    const given = Buffer.from(token.slice(i + 1));
    const want = Buffer.from(this.mac(body));
    if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
    const id = body.slice(0, body.indexOf("."));
    return identityDef(id) ? id : undefined;
  }
  private mac(body: string) {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
