# VulnSeal

**Privacy-Preserving Cross-Platform Bug Bounty Priority and Dispute Arbitration Using Blockchain Commitments.** A local-only research prototype.

VulnSeal is a shared verification and arbitration layer for independent bug bounty programs.

- **Researchers** commit to confidential reports; only a hash goes on a shared ledger. They reveal the report to the receiving program later.
- **Anyone** can check that a revealed report is exactly what was committed earlier.
- **Programs** associate overlapping reports across programs through independent review.
- **Arbitrators** settle priority and validity disputes in an append-only, attributable record.

Report contents, evidence and nonces never go on-chain.

It is **not** a bug bounty platform, a scanner, an AI detector, a public vulnerability database or a token system. Everything in it is **fictional and synthetic**. Do not enter real undisclosed vulnerabilities.

> A commitment shows that a specific report existed by the time the ledger recorded it. It does **not** show that the report is true, valid or first discovered in the real world, and an arbitrator can still decide wrongly. See [docs/threat-model.md](docs/threat-model.md).

## Start

```bash
./run.sh
```

The script:

1. checks prerequisites;
2. installs dependencies if needed;
3. compiles the contract;
4. starts a local Hardhat chain;
5. on first run, deploys the contract and seeds fictional programs, researchers, reports, associations and disputes; on later runs, **restores the same ledger** by replaying its transaction journal;
6. builds the frontend and starts the server;
7. waits until the app is healthy;
8. prints the URLs and opens the browser.

Open **http://127.0.0.1:4700**. If ports 4700 or 8545 are busy, the script picks free ones and says so. **Ctrl+C** stops everything; your data stays in `data/`.

| Option | Effect |
|--------|--------|
| `./run.sh --reset` | Archive the current data and start a fresh, re-seeded ledger |
| `./run.sh --no-open` | Don't open a browser |

### Prerequisites

- **macOS (Apple Silicon) or Linux.**
- **Node.js 22.18+** (tested with 24.19). The project uses Node's built-in TypeScript execution and `node:sqlite`, so it needs no Docker and no native builds.
- **Internet once**, for `npm ci` and the solc 0.8.28 download. After that it runs offline. No cloud service, API key or wallet is needed.

## Using it

Choose an identity in **Signed in as**. This is a *simulated* sign-in: a signed session cookie with no password. The fictional cast:

| Group | Identities |
|-------|-----------|
| Researchers | basalt, quillfox, nightjar |
| Programs | Ashgrove Payments (A), Kestrel Cloud (B), Tamarind Mobile (C) — each has an admin and a triage reviewer |
| Arbitrators | Holm, Okafor, Vance and Sato (independent); Reyes (affiliated with Ashgrove, so conflicted in Ashgrove disputes) |
| Other | Auditor (read-only), Consortium desk, Unregistered visitor |

**Quickest tour:** open **Demo scenario** and press *Run step* 14 times. Each step performs real contract transactions as the named identities, including four attempts the contract is expected to reject.

**By hand:**

1. **Researcher workspace → New confidential report** as basalt. Commit it, then download the receipt and the private reveal package.
2. Switch to **Ashgrove triage**. On the report, choose **Acknowledge**, then **Request reveal**. The content stays withheld.
3. Back as basalt, **Reveal**. Try *an edited copy* first: the pre-check says *mismatch*, and when the reviewer verifies it the mismatch is recorded on-chain permanently. Then reveal *the sealed original* and verify it: *match*.
4. **Propose a cross-program association** (after the other researcher grants disclosure). Only the *other* program can confirm it, which assigns an issue-family token.
5. Open a **priority dispute** as a party. In **Disputes**:
   - a non-arbitrator, or the conflicted Reyes, is rejected by the contract;
   - Holm and Okafor decide;
   - a party appeals, and Vance and Sato hear it;
   - both rounds stay on record.
6. **Cross-program explorer** shows what every participant sees (pseudonyms, hashes, states, no content).
7. **Audit & verification** (as the auditor) runs the integrity check, exports and attests, and hosts the tamper lab.
8. **Receipt verifier** checks any receipt against the chain without signing in.
9. **Research benchmark** runs the comparison against the centralised baselines.

## Commands

| Command | Purpose |
|---------|---------|
| `./run.sh` | Start everything (restores existing data) |
| `npm test` | Contract tests and backend/API tests (16 + 22), each against a real local chain |
| `npm run test:smoke` | Runs `./run.sh` on isolated ports, creates data, stops, restarts and checks the ledger was restored |
| `npm run typecheck` | TypeScript checks for server, scripts, tests and web |
| `npm run benchmark -- --reports 40 --seed 42 --trials 12` | Comparative benchmark → `docs/results/` |
| `npm run ledger [-- --watch]` | Readable view of every block and log entry on the running chain |
| `npm run integrity` | Auditor integrity check against the running deployment |
| `npm run verify-receipt -- receipt.json [--reveal package.json] [--rpc URL]` | Verify a receipt using only the chain |
| `npm run verify-audit -- audit.json [--rpc URL]` | Re-verify an exported audit report offline |

## Documentation

- [docs/research-gap.md](docs/research-gap.md) — related work (verified sources), candidate contribution, research questions, limitations
- [docs/architecture.md](docs/architecture.md) — components, data placement, lifecycle state machine (Mermaid), persistence, access control
- [docs/commitment-protocol.md](docs/commitment-protocol.md) — exact encoding, commitment, receipt, reveal verification
- [docs/threat-model.md](docs/threat-model.md) — adversaries, contract versus application protections, unsolved problems, privacy
- [docs/experiment-protocol.md](docs/experiment-protocol.md) and [docs/results/](docs/results/README.md) — benchmark design and measured results
- [MIGRATION_NOTES.md](MIGRATION_NOTES.md) — what was reused from PatchLedger and how to roll back
- [DEMO.md](DEMO.md) — presentation guide
- [PROGRESS.md](PROGRESS.md) — test commands, results, limitations

## When is a shared ledger worth it?

It helps when several programs that don't fully trust one another, or one operator, need the same record:

- who committed what, and when;
- who was allowed to decide;
- what was decided.

A **centralised database** is simpler, faster and leaks less metadata. In the benchmark, a hash-chained log with external checkpoints matched the ledger on detecting rewrites. Only per-party signatures enforced outside the operator stopped an operator forging votes in someone else's name.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Node.js … is too old` | Install Node 22.18+ (e.g. `brew install node@24`) |
| `contract compilation failed` on first run | solc must be downloaded once: connect to the internet and re-run |
| `replay diverged …` during startup | The journal and chain don't match (e.g. a manual edit). Run `./run.sh --reset`, which archives the data and starts fresh |
| `Database belongs to contract …` | Run `./run.sh --reset` |
| Ports busy | The script picks free ports and prints them; or set `VS_PORT` / `VS_CHAIN_PORT` |
| "ledger node unavailable" in the sidebar | The chain process stopped; see `data/logs/chain.log`, then restart with `./run.sh` |

## Configuration

These environment variables are all optional and none is secret:

| Variable | Default |
|----------|---------|
| `VS_PORT` | `4700` |
| `VS_CHAIN_PORT` | `8545` |
| `VS_DATA_DIR` | `data` |
| `VS_DEMO_LAB` | `1` (set to `0` to disable the tamper lab) |
| `VS_NO_OPEN` | unset (set to `1` to skip opening the browser) |

Keys are generated locally into `data/keys/` (mode 0600). Never put real keys or seed phrases anywhere in this project.

## Status

Research prototype on a single local chain:

- Sign-in is simulated, and the server holds every demo key.
- The vault key sits on the server.
- There is no audit, user study, field data or compliance claim.

See the threat model and `PROGRESS.md`.
