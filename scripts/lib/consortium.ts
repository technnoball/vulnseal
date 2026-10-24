// Create a consortium on a chain: deploy VulnSeal, register the three fictional programs
// with their policy digests, register every demo participant. Shared by bootstrap, the
// benchmark and the tests so they all start from the same setup.
import { keccak256, toUtf8Bytes } from "ethers";
import { Ledger, deployVulnSeal, registerParticipants } from "../../server/chain.ts";
import type { Store } from "../../server/db.ts";
import { PROGRAMS } from "../../server/domain.ts";
import type { Journal } from "../../server/journal.ts";
import type { Keyring } from "../../server/keys.ts";
import { POLICY_TEXTS } from "../../server/policies.ts";

export async function initConsortium(opts: { rpcUrl: string; keyring: Keyring; store: Store; journal?: Journal; appealWindowSeconds: number; threshold?: number }) {
  const { address, gasUsed } = await deployVulnSeal({ rpcUrl: opts.rpcUrl, keyring: opts.keyring, journal: opts.journal, appealWindowSeconds: opts.appealWindowSeconds, threshold: opts.threshold ?? 2 });
  const ledger = new Ledger({ rpcUrl: opts.rpcUrl, address, keyring: opts.keyring, journal: opts.journal });
  const now = () => new Date().toISOString();
  opts.store.setMeta("contract", address);
  for (const p of PROGRAMS) {
    const first = POLICY_TEXTS[p.id][0];
    const nameTag = keccak256(toUtf8Bytes(`vulnseal:program:${p.slug}`));
    await ledger.send("governor", "registerProgram", [nameTag, keccak256(toUtf8Bytes(first))]);
    opts.store.run("INSERT INTO programs(id, slug, name, short, blurb, name_tag) VALUES (?, ?, ?, ?, ?, ?)", p.id, p.slug, p.name, p.short, p.blurb, nameTag);
    opts.store.run("INSERT INTO policies(program_id, version, digest, body, published_at) VALUES (?, 1, ?, ?, ?)", p.id, keccak256(toUtf8Bytes(first)), first, now());
  }
  await registerParticipants(ledger);
  // later policy versions are published by each program's own admin
  for (const p of PROGRAMS) {
    for (const [i, body] of POLICY_TEXTS[p.id].slice(1).entries()) {
      await ledger.send(`${p.slug}-admin`, "publishPolicy", [p.id, keccak256(toUtf8Bytes(body))]);
      opts.store.run("INSERT INTO policies(program_id, version, digest, body, published_at) VALUES (?, ?, ?, ?, ?)", p.id, i + 2, keccak256(toUtf8Bytes(body)), body, now());
    }
  }
  return { address, gasUsed, ledger };
}
