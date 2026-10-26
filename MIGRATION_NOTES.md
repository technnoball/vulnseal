# Migration notes: PatchLedger → VulnSeal

## Decision

**Option A — modify in place, on a separate git branch.** PatchLedger's infrastructure was modular: contract tooling, ledger client, SQLite layer, startup script, design system and test harness were independent of its repair domain. The domain-specific parts (contract, service, pages, seed data, benchmark, documents) were replaced rather than adapted.

## Rollback path

| What | Where |
|------|-------|
| PatchLedger code, as presented | commit `a296516` (in this repository's history), local branch `patchledger` and tag `patchledger-v1` |
| PatchLedger runtime data (database, evidence, archives) | `data-patchledger/` (gitignored, untouched) |
| PatchLedger documents and benchmark results | `docs/archive-patchledger/` and at commit `a296516` |
| The interrupted first attempt at this migration (22 Oct), exactly as found | tag `vulnseal-wip-2026-10-22` (a stash commit including untracked files) |
| VulnSeal | branch `main` (GitHub: `technnoball/vulnseal`) |

VulnSeal was developed on a `vulnseal` branch on top of PatchLedger's `main` and published as its own repository on 26 Oct 2026. Locally, PatchLedger's branch was renamed `patchledger` and VulnSeal's became `main`. If the `patchledger` branch is missing (for example in a fresh clone), recreate it with `git branch patchledger a296516`.

To run PatchLedger again:

```bash
git switch patchledger
```

```bash
./run.sh
```

Back to VulnSeal:

```bash
git switch main
```

The two projects use different default ports (PatchLedger 4600, VulnSeal 4700) and different data files.

## What was found on arrival

The `vulnseal` branch already existed, holding a half-finished migration:

- **Staged:** PatchLedger documents moved to `docs/archive-patchledger/`, and old modules deleted.
- **Untracked copies:** 9 files byte-identical to PatchLedger's `main` (its contract, service, seed, documents).
- **New, unfinished work:** VulnSeal infrastructure modules from 22 Oct:
  - `commitment.ts`, `journal.ts`, `vault.ts`, `keys.ts`, `session.ts`;
  - reworked `chain.ts`, `db.ts`, `domain.ts`, `config.ts`;
  - a test fixture.
- **Missing:** no contract, service, API, frontend or tests for VulnSeal.

That state was snapshotted under tag `vulnseal-wip-2026-10-22` before anything changed. The new modules were reviewed and kept; the PatchLedger copies were removed from this branch.

## Reused from PatchLedger (adapted where noted)

| Component | Notes |
|-----------|-------|
| Hardhat 2.29 + solc 0.8.28 setup (`hardhat.config.cjs`) | Added an optional start date for the local chain (needed for journal replay) |
| `scripts/lib/chainproc.ts` | Starts a local node; added the start-date option |
| `server/canonical.ts` | Used by the hardened baseline's hash chain |
| Ledger client pattern (local signing, transaction queue, revert decoding, `cacheTimeout: -1` nonce fix) | Rewritten for VulnSeal's contract and error set, with journaling |
| SQLite via `node:sqlite`, Express 5, multer, ethers 6, React 19 + Vite 7 | Unchanged dependencies |
| Router, API client pattern, UI primitives (page heads, sheets, stamps, hashes, notices, fields, loaders) | Extended with sealed/withheld/ledger panels, state stamps and checks |
| Design tokens and CSS (`web/src/styles.css`) | Same palette and typography; added VulnSeal components |
| `run.sh` structure (prerequisites, port fallback, health waits, clean Ctrl+C) | Now restores the ledger instead of resetting it; `--reset` added |
| Benchmark structure (seeded workload, P/D/U scenario matrix, Markdown report) | New designs, scenarios and disclosure scan |
| Test approach (node:test against a real local chain; smoke test of `run.sh`) | New tests |

## Replaced

- **Contract:** `PatchLedger.sol` → `VulnSeal.sol` (roles, commitments, triage state machine, associations, disputes, a hash-chained log).
- **Domain model, service, API routes, all pages, seed data, demo runner, tamper lab, integrity checker** — repair passports → bug-bounty commitments and arbitration.
- **Demo identities:** PatchLedger used the public Hardhat test keys. VulnSeal generates fresh keys per installation, stored encrypted; a Hardhat development account only funds gas.
- **Sign-in:** the plain `X-Demo-Actor` header → an HMAC-signed session cookie (still simulated).
- **Documents:** README, research gap, architecture, threat model, experiment protocol and results were rewritten. `commitment-protocol.md` is new.

## Added

- **Icon library:** `lucide-react` 1.61.
- **Persistence:** the journal-replay mechanism, so the ledger survives restarts.
- **CLIs:** `verify-receipt`, `verify-audit`, `integrity`, `ledger`.

## Preserved user data

Nothing under `data-patchledger/` was modified. VulnSeal writes to `data/` (gitignored). `./run.sh --reset` archives VulnSeal's own data to `data/archive/` instead of deleting it.
