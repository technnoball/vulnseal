// At-rest encryption for report contents, notes and evidence (AES-256-GCM).
// Prototype key management: one random master key in data/keys/master.key (mode 0600),
// with per-scope keys derived by HKDF. The AAD binds each ciphertext to the record it
// belongs to, so a ciphertext copied into another row fails to decrypt.
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export class Vault {
  private master: Buffer;
  private cache = new Map<string, Buffer>();

  constructor(master: Buffer) {
    if (master.length !== 32) throw new Error("master key must be 32 bytes");
    this.master = master;
  }

  static open(keyDir: string): Vault {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const p = path.join(keyDir, "master.key");
    if (!fs.existsSync(p)) fs.writeFileSync(p, randomBytes(32), { mode: 0o600, flag: "wx" });
    return new Vault(fs.readFileSync(p));
  }

  private key(scope: string): Buffer {
    let k = this.cache.get(scope);
    if (!k) {
      k = Buffer.from(hkdfSync("sha256", this.master, Buffer.alloc(0), `vulnseal/v1/${scope}`, 32));
      this.cache.set(scope, k);
    }
    return k;
  }

  seal(scope: string, aad: string, plain: Uint8Array): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(scope), iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
  }

  open(scope: string, aad: string, sealed: Uint8Array): Buffer {
    const b = Buffer.from(sealed);
    if (b[0] !== 1) throw new Error("unknown ciphertext version");
    const d = createDecipheriv("aes-256-gcm", this.key(scope), b.subarray(1, 13));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(13, 29));
    return Buffer.concat([d.update(b.subarray(29)), d.final()]);
  }

  sealJson(scope: string, aad: string, value: unknown): Buffer {
    return this.seal(scope, aad, Buffer.from(JSON.stringify(value)));
  }

  openJson<T>(scope: string, aad: string, sealed: Uint8Array): T {
    return JSON.parse(this.open(scope, aad, sealed).toString("utf8")) as T;
  }
}
