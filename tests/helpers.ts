import assert from "node:assert/strict";
import { Contract } from "ethers";

/** Assert that a contract call reverts with the given custom error name. */
export async function expectRevert(p: Promise<unknown>, errorName: string, iface?: Contract): Promise<void> {
  try {
    await p;
  } catch (e) {
    const err = e as any;
    let name: string | undefined = err?.revert?.name ?? err?.contractError?.name;
    if (!name && iface && err?.data) {
      try {
        name = iface.interface.parseError(err.data)?.name;
      } catch {
        /* ignore */
      }
    }
    if (!name) name = /custom error '(\w+)/.exec(String(err?.message))?.[1];
    assert.equal(name, errorName, `expected revert ${errorName}, got ${name ?? "unknown"}: ${err?.message}`);
    return;
  }
  assert.fail(`expected revert ${errorName}, but the call succeeded`);
}
