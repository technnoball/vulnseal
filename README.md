# PatchLedger

**Evidence-Aware and Dispute-Resolvable Blockchain Repair Passports for Refurbished Laptops in India's Multi-Repair Ecosystem.** A runnable, local-only research prototype.

PatchLedger keeps an append-only, evidence-linked repair history for each laptop. Each history is anchored in a real Solidity contract on a local Ethereum-compatible chain. Repairers, refurbishers, buyers and auditors are separate parties, and the **contract** enforces what each may do.

The ledger records *who claimed what, when, and with which evidence file*, and it makes later changes detectable. It does **not** prove that a claim about the physical world is true.

> All devices, providers and documents in the demo are **synthetic and fictional**. The keys come from the public Hardhat test mnemonic: **local use only, never on a real network.**

## Quick start

```bash
./run.sh
```

The script:

1. checks the prerequisites,
2. installs dependencies if they are missing,
3. compiles the contract,
4. starts a local Hardhat chain,
5. deploys the contract,
6. seeds the demo data,
7. builds and serves the web app,
8. waits until the app responds,
9. prints the URLs,
10. opens your browser.

The default URL is **http://127.0.0.1:4600**. If ports 4600 or 8545 are busy, the script picks free ports and prints them. Press **Ctrl+C** to stop everything. `./run.sh --no-open` skips opening the browser.

### Prerequisites

- macOS (Apple Silicon or Intel) or Linux.
- **Node.js 22.18 or newer** (tested with 24.19). The project uses Node's built-in TypeScript execution and `node:sqlite`, so there is no native build step and no Docker.
- Internet access **once**, for `npm ci` and so Hardhat can download the solc 0.8.28 compiler. After that everything runs offline.
- `curl`, which macOS already includes.

### State and resets

The Hardhat chain lives in memory. Every `./run.sh` therefore starts a **fresh chain**, archives the previous off-chain data under `data/archive/<timestamp>/`, and reseeds the demo. Records you created in an earlier session remain in the archive, but they are not reloaded, because their on-chain commitments no longer exist.

## What to try (about 5 minutes)

1. Use **Acting as** (top bar) to pick a demo identity. Each one holds different on-chain roles.
2. **Device passports**: open *HP EliteBook 840 G5*. It shows a battery replacement (#002), a later inspection that claims the original battery (#003, a conflict), and an open buyer challenge (#004). Record #002's receipt is byte-identical to one submitted for the Dell, which triggers a reuse warning.
3. As **Kiran Bench Repairs**, choose **Record new event**, fill in a repair, upload a file (it is hashed), and commit it. The new record appears marked *anchored on-chain*.
4. Open an evidence file, then choose **Verify integrity now** to re-hash it and compare it with the on-chain commitment.
5. As **Demo Buyer**, use **Challenge** on a record. Then try **Resolve dispute**: the contract rejects it with `NotAuthorized`.
6. Switch to **Open Audit Collective** and resolve the dispute. The original claim, the challenge and the resolution all remain in the history.
7. In **Audit & export**, the tamper lab can edit or delete a database row or alter an evidence file. The integrity checker flags each change; *Restore all* undoes them. **Attempt on-chain rewrite** sends real transactions, and the contract rejects them.
8. Use **Export JSON** and verify the file independently:

   ```bash
   npm run verify-export -- ~/Downloads/patchledger-<ID>-history.json --rpc http://127.0.0.1:8545
   ```

9. In **Research benchmark**, run the comparison against centralized stores. It uses its own throw-away chain.
10. **Public verification** (`/verify/<ID>`, also reachable from the QR code) is a read-only view. It never shows evidence contents or free text.

## Evidence categories

| Category | Meaning |
|----------|---------|
| Self-reported | No supporting file |
| Evidence attached | File(s) attached; SHA-256 matches the digest committed on-chain |
| Independently corroborated | A *different* authorized party recorded a corroboration with its own evidence |
| Disputed | An unresolved challenge exists |
| Corrected / superseded | A later correction references the claim (the original stays visible) |
| Evidence integrity failed | A file no longer matches its committed digest |

A matching digest shows a file is **unchanged since submission**, not that it is genuine.

## Commands

| Command | Purpose |
|---------|---------|
| `./run.sh` | Full startup (the only command you need) |
| `npm test` | Compile, then run contract tests and application/API tests (each against a real local chain) |
| `npm run test:smoke` | Runs `./run.sh` on isolated ports, checks every service and seeded page, then checks clean shutdown |
| `npm run typecheck` | TypeScript checks for the server, scripts, tests and web |
| `npm run benchmark -- --devices 20 --events 10 --seed 42 --trials 20` | Comparative benchmark; writes to `docs/results/` |
| `npm run ledger [-- --watch]` | Show the raw blockchain: every block, transaction and decoded record; `--watch` follows new blocks live |
| `npm run integrity [-- PL-XXXX-XXXX]` | Compares the off-chain store and evidence with on-chain commitments, using the running deployment |
| `npm run verify-export -- <file> [--rpc URL] [--evidence-dir data/evidence]` | Server-independent verification of an export |
| `npm run dev:web` | Vite dev server with hot reload (proxies `/api` to the running server) |

## Project structure

```
contracts/PatchLedger.sol     role-based, append-only repair passport contract
hardhat.config.cjs            compile + local node only (no public networks configured)
server/                       Express API, domain service, ethers ledger client, SQLite store,
                              evidence vault, canonical hashing, tamper lab
web/                          React + Vite frontend; design system in web/src/styles.css
scripts/                      deploy, seed, benchmark (+ baselines), integrity-check, verify-export
tests/contract|app|smoke/     automated tests
docs/                         research-gap, architecture, threat-model, experiment-protocol, results/
run.sh                        one-command startup
PROGRESS.md                   build log, test results, limitations
```

## Documentation

- [DEMO.md](DEMO.md): presentation guide (checklist, demo flow, likely questions).
- [docs/research-gap.md](docs/research-gap.md): related work (verified metadata), the gap, research questions, and what is demonstrated versus hypothesized.
- [docs/architecture.md](docs/architecture.md): component and data-flow diagrams (Mermaid), hashing, and integrity checks.
- [docs/threat-model.md](docs/threat-model.md): adversaries, contract-enforced versus application-only protections, privacy, and prototype versus production.
- [docs/experiment-protocol.md](docs/experiment-protocol.md): benchmark design, metrics, hypotheses, and reproducibility.
- [docs/results/](docs/results/README.md): generated benchmark output and a summary.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Node.js … is too old` | Install Node 22.18+ (for example `brew install node@24` or the installer from nodejs.org), then re-run. |
| `contract compilation failed` on first run | Hardhat must download solc 0.8.28 once. Connect to the internet and re-run. The compiler is then cached in `~/Library/Caches/hardhat-nodejs`. |
| Ports already in use | The script picks free ports automatically and prints them. You can also set `PL_PORT` or `PL_CHAIN_PORT`. |
| Banner shows "Ledger node unavailable" | The chain process stopped. Check `data/logs/chain.log`, then restart with `./run.sh`. |
| `database … belongs to contract …` when running `node server/index.ts` by hand | The chain was restarted. Use `./run.sh`, which redeploys and reseeds. |
| A blank PDF frame in some embedded browsers | Use **Open in new tab** under the viewer. |
| Logs | `data/logs/{chain,server,compile,web-build}.log` |

## Configuration

These environment variables are all optional and none is secret, so there is no `.env` file:

- `PL_PORT` (default 4600)
- `PL_CHAIN_PORT` (default 8545)
- `PL_DATA_DIR` (default `data`)
- `PL_DEMO_LAB=0` disables the tamper lab
- `PL_NO_OPEN=1` skips opening the browser

## Status and limitations

This is a research prototype. It has no user study, real repair data, partnership, security audit or regulatory compliance claim. Demo identities are chosen with a request header (no authentication), and the server holds every demo key. See the threat model and `PROGRESS.md` for the full list.
