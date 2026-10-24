// Demo identities get freshly generated keys on first start (not the public Hardhat
// test keys). They are stored encrypted with the local master key and never leave the
// machine. The faucet is Hardhat's genesis account #0, used only to pay for gas.
import fs from "node:fs";
import { HDNodeWallet, Mnemonic, Wallet, getAddress } from "ethers";
import { IDENTITY_DEFS, type IdentityDef } from "./domain.ts";
import type { Vault } from "./vault.ts";

const HARDHAT_TEST_MNEMONIC = "test test test test test test test test test test test junk";

export function faucetWallet(): Wallet {
  const hd = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_TEST_MNEMONIC), "m/44'/60'/0'/0/0");
  return new Wallet(hd.privateKey);
}

export class Keyring {
  private wallets = new Map<string, Wallet>();
  private byAddress = new Map<string, string>();

  constructor(keys: Record<string, string>) {
    for (const [id, pk] of Object.entries(keys)) {
      const w = new Wallet(pk);
      this.wallets.set(id, w);
      this.byAddress.set(w.address.toLowerCase(), id);
    }
  }

  static generate(defs: IdentityDef[] = IDENTITY_DEFS): Keyring {
    return new Keyring(Object.fromEntries(defs.map((d) => [d.id, Wallet.createRandom().privateKey])));
  }

  static load(file: string, vault: Vault): Keyring {
    return new Keyring(vault.openJson<Record<string, string>>("keyring", "identities", fs.readFileSync(file)));
  }

  save(file: string, vault: Vault) {
    const keys = Object.fromEntries([...this.wallets].map(([id, w]) => [id, w.privateKey]));
    fs.writeFileSync(file, vault.sealJson("keyring", "identities", keys), { mode: 0o600 });
  }

  ids() {
    return [...this.wallets.keys()];
  }

  wallet(id: string): Wallet {
    const w = this.wallets.get(id);
    if (!w) throw new Error(`no key for identity "${id}"`);
    return w;
  }

  address(id: string): string {
    return this.wallet(id).address;
  }

  idOf(address: string): string | undefined {
    try {
      return this.byAddress.get(getAddress(address).toLowerCase());
    } catch {
      return undefined;
    }
  }
}
