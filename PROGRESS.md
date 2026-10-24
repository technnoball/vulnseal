# PROGRESS — VulnSeal

## Environment

- macOS 26.5 on arm64 (Apple M4), Node v24.19.0, npm 11.17.0.
- Branch `vulnseal`. PatchLedger is preserved on `main`, in tag `patchledger-v1` and in `data-patchledger/`. See [MIGRATION_NOTES.md](MIGRATION_NOTES.md).
- **Dependencies:**
  - Runtime: express 5.3, multer 2.5, ethers 6.17, qrcode, react / react-dom 19.3, lucide-react 1.61, IBM Plex fonts.
  - Development: hardhat 2.29.1 (solc 0.8.28), typescript 5.9, vite 7.3, @vitejs/plugin-react 5.2.
  - Built into Node: `node:sqlite` and TypeScript type stripping.

## Completed (in build order)

- [x] **Phase 1.** Inspected the workspace and found a half-finished migration. Snapshotted it under tag `vulnseal-wip-2026-10-22`, then chose to modify in place.
- [x] **Phase 2.** Verified the seven related-work sources (Crossref, Semantic Scholar, fetched pages) and wrote `docs/research-gap.md`. Wrote the commitment protocol, threat model, architecture and experiment protocol.
- [x] **Phase 3.** `contracts/VulnSeal.sol` (19.3 KB of bytecode) and 16 contract tests.
- [x] **Phase 4.** Backend:
  - commitment and receipt modules, AES-256-GCM vault, HMAC sessions, generated keyring;
  - transaction journal with replay;
  - service with server-side access control, auditor integrity check, tamper lab;
  - Express API, CLIs.
- [x] **Phase 5.** Nine-page React frontend reusing the archival design system, with a sealed/withheld/ledger visual distinction and lucide icons. Responsive down to 375 px.
- [x] **Phase 6.** Fictional seed data (3 programs, 3 researchers, 10 reports covering every lifecycle state, a completed appealed arbitration, an open dispute, a recorded reveal mismatch, a revision). A 14-step guided demo that runs real transactions.
- [x] **Phase 7.** Editable, hardened and checkpointed baselines; seeded benchmark with 12 scenarios; disclosure scan with a positive control; reports in `docs/results/`.
- [x] **Phase 8.** Full tests, browser acceptance test, fixes.
- [x] **Phase 9.** Clean-state `./run.sh` (no `node_modules`, `build`, `web/dist` or `data`), documentation.

## Test commands and results (last run 24 Oct 2026)

| Command | Result |
|---------|--------|
| `npm run typecheck` | pass (server, scripts, tests, web) |
| `npm test` | **38/38 pass** — 16 contract tests and 22 app tests (13 API workflow, 9 unit: encoding, vault, sessions, journal replay) |
| `npm run test:smoke` | **1/1 pass** — `./run.sh` on isolated ports; health, frontend bundle, SPA route, seeded figures; creates a report; Ctrl+C; restarts; the journal is replayed; report, log head and audit intact; both ports released |
| `npm run integrity` | consistent (fresh instance: 10 commitments, 7 reveals, 2 evidence files, 2 associations, 2 disputes) |
| `npm run verify-receipt` / `verify-audit` | VALID / every entry hash and link recomputes; matches the live chain |
| `npm audit --omit=dev` | 0 vulnerabilities, after `npm audit fix` bumped body-parser to 2.4.0 and multer to 2.5.0 |
| `npm run benchmark` (×3) | Seeds 42, 7 and 42-from-UI; 40 reports and 12 trials each; identical scenario outcomes. See [docs/results/README.md](docs/results/README.md) |

### Browser acceptance test (section 17 of the brief)

All 19 steps were performed against the instance started by `./run.sh`, in the built-in browser:

| Step | What happened |
|------|---------------|
| 1–2 | Started and opened at http://127.0.0.1:4700 |
| 3–5 | Signed in as basalt (Program A) and committed VS-0011 through the form: block 91, 165,666 gas |
| 6 | Downloaded the receipt (HTTP 200) |
| 7 | "Verify the receipt against the chain": every check passed |
| 9 | basalt revealed an **edited** copy: pre-check *mismatch*; Ashgrove triage recorded *mismatch* on-chain |
| 8 | Revealed the sealed original: *match*, recorded on-chain; the earlier failed check stays visible |
| 10 | quillfox committed VS-0012 to Program B, revealed and verified *(driven through the HTTP API with curl — the same UI path as steps 3–9)*; both researchers granted cross-program disclosure *(API)* |
| 11 | In the UI, Ashgrove triage proposed "same issue"; Kestrel triage confirmed; issue-family token assigned |
| 12 | In the UI, quillfox opened priority dispute #3 |
| 13 | In the UI, the Kestrel admin's vote was **rejected by the contract** (`NotAuthorized(…, 8)`) |
| 14 | Holm voted in the UI. Okafor's vote, quillfox's appeal and the Vance and Sato appeal votes went through the API; Holm was refused a seat on the appeal (`PriorPanelMember`); the dispute became final with the decision reversed |
| 15 | The dispute page shows the round-1 decision, the appeal decision, all five acts, the statement, the policy reference and nine ledger events |
| 16 | As Tamarind triage, VS-0011's content is withheld; direct API calls for its receipt and recovery package return 403 |
| 17 | Exported the audit report and receipt: `verify-audit` recomputes all 99 entries and matches the live chain; `verify-receipt` returns VALID with the reveal matching. The UI integrity check reports "Consistent" |
| 18 | Ran the benchmark from the Research page (exit 0); tables rendered |
| 19 | Stopped (SIGTERM → "stopped. Data kept") and restarted with `./run.sh`: 108 transactions replayed in 622 ms, identical log head, VS-0011 and dispute #3 intact, audit consistent, and the **pre-restart receipt still VALID** |

The browser automation drove some repeated steps through the same HTTP API the frontend uses, to save time; these are marked *(API)* above. Every new workflow was performed in the UI at least once.

### Bugs found and fixed during the work

- **Contract:** opening a second dispute on a disputed association reported `InvalidSubject` instead of `DisputeExists` (check order).
- **Bootstrap:**
  - published later policy versions before program admins were registered;
  - archived an empty directory created by the journal itself.
- **Benchmark fairness:**
  - the checkpoint witness kept only the latest head, so the hardened baseline looked worse than it should. Fixed to keep all witnessed heads;
  - insider trials on hardened logs were not isolated, so leftover damage inflated later detections. Fixed with snapshot and restore.
- **Privacy:** the on-chain reveal digest did not include the nonce, allowing guesses about revealed content to be tested. Fixed: the nonce is now bound into it, with a test.
- **UI:**
  - checklist and table overflow on narrow screens;
  - duplicated "Rejected by the contract" wording;
  - the dispute-opened confirmation was lost on reload (now navigates to the dispute);
  - radio label wrapping;
  - the vote form was hidden from non-arbitrators, which made the contract's rejection impossible to demonstrate.
- **Dependencies:** body-parser and multer DoS advisories (patched).

## Remaining limitations

- **Simulated sign-in, server-held keys.** Choosing an identity issues an HMAC cookie with no password. The server holds every participant's key, so the operator could act as anyone, which defeats the multi-party guarantee. The benchmark models per-party keys instead.
- **Single local chain.** One node; no decentralisation or consensus. Journal replay provides durability, not trust. Block times ran about a minute ahead of wall-clock time after bursts.
- **Vault key beside the data.** At-rest encryption protects copies of the database and evidence files, not a compromised server.
- **Reveal attestations are trusted.** The contract cannot verify a `MATCH` record without the nonce. The audit re-checks stored reveals.
- **Relationship detection is manual.** There is no privacy-preserving matching.
- **Metadata exposure.** Pseudonyms are linkable across programs; family tokens and decisions are visible to every participant (measured).
- **Literature review is preliminary.** Seven sources, verified metadata, not all read in full; Zhu et al.'s abstract was unavailable. No systematic search.
- **Evaluation:** one machine, synthetic data, one attacker model, descriptive statistics only. No user study, field data, audit or compliance claim.
- **Frontend tests** are API-level workflow tests plus the manual browser acceptance test above. No automated headless-browser suite (no browser-automation dependency was added).
- **Development tooling** (Hardhat's dependency tree) has open `npm audit` advisories (19, none in runtime packages). Not addressed, because `audit fix --force` would require breaking upgrades.
