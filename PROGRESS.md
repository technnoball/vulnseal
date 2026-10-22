# PROGRESS

## Environment

macOS 26.5.2 on arm64 (Apple M4), Node v24.19.0, npm 11.17.0. The workspace was empty, so the project is built at the root.

Dependencies:

- **Runtime:** express 5.3, multer 2.4, ethers 6.17, qrcode 1.5, react / react-dom 19.3, @fontsource IBM Plex Sans and Mono.
- **Development:** hardhat 2.29.1, typescript 5.9, vite 7.3, @vitejs/plugin-react 5.2, plus type packages.
- **Built into Node:** `node:sqlite` and TypeScript type stripping, so there is no ts-node, tsx or better-sqlite3.

## Completed

- [x] Phase 1: workspace and prerequisite inspection; stack chosen.
- [x] Phase 2: `PatchLedger.sol` covering roles, append-only records, prev-hash check, challenges and resolutions with separation of duties, corrections, corroboration, evidence attachment, and `verifyChain()`. Deployment script, local chain helper, and 11 contract tests.
- [x] Phase 3: canonical hashing, SQLite store, evidence vault (SHA-256), domain service (evidence status, conflict detection, integrity checker, export, report), Express API, and tamper lab.
- [x] Phase 4: React frontend with nine working pages and an archival design system: flat palette, no gradients, IBM Plex plus a serif, visible focus, responsive down to 375 px.
- [x] Phase 5: synthetic seed (4 devices: clean history with a correction, a corroborated battery replacement, a conflict with an open dispute and a reused receipt, and a self-reported repair). Centralized baselines and the benchmark with 11 scenarios.
- [x] Phase 6: tests, `./run.sh`, smoke test, and browser acceptance walkthrough.
- [x] Phase 7: documentation.

## Test commands and results (last run 2026-10-21)

| Command | Result |
|---------|--------|
| `npm run typecheck` | pass (server, scripts, tests, web) |
| `npm test` | **29/29 pass**: 11 contract tests and 18 app tests (15 API, 3 canonicalization) |
| `npm run test:smoke` | **1/1 pass**: `./run.sh` on isolated ports; health, chain, frontend bundle, 4 seeded devices (API, SPA route, public integrity); clean shutdown on SIGINT with both ports released |
| `npm run integrity` | 4/4 seeded devices verified (expected `EVIDENCE_DIGEST_REUSED` warnings) |
| `npm run verify-export` | PASS on an exported history, against the live chain and evidence files. A tampered export fails, as covered by the tests. |
| `npm run benchmark` | 5 runs saved in `docs/results/` (see its README). Canonical run: seed 42, 20×10, 20 trials. |

### Browser acceptance (built-in browser, against `./run.sh`)

All 15 steps were completed:

1. Started with `./run.sh`.
2. Opened the app.
3. Selected an identity.
4. Opened a seeded passport.
5. Inspected the events, then opened the evidence viewer and ran "Verify integrity now", which matched.
6. Created repair #006 through the form.
7. Uploaded and hashed evidence in the same form.
8. Committed #006; the passport showed "anchored on-chain".
9. Tamper lab:
   - a database edit was flagged `PAYLOAD_DIGEST_MISMATCH`, and the public page then showed ALTERED;
   - three real on-chain rewrite attempts were rejected (`StalePrevHash`, `NotAuthorized`, revert);
   - restore brought integrity back.
10. The buyer challenged #006.
11. The buyer's own resolution attempt was rejected by the contract with `NotAuthorized(…, 16)`.
12. The auditor resolved the dispute with "claim rejected".
13. #006, challenge #007 and resolution #008 all remained visible.
14. Export JSON passed `verify-export` with `--rpc` and `--evidence-dir`; the report showed PASS.
15. The benchmark was run from the Research page (exit 0) and its tables rendered.

The file upload in step 7 was driven by setting the file input through a script, because automation cannot operate the native file dialog. The Upload and Commit buttons were clicked normally.

### Bugs found and fixed during verification

- An ethers 250 ms request cache returned stale nonces (fixed with `cacheTimeout: -1`).
- The conflict detector anchored on the first replacement even when it had been superseded. The benchmark exposed this (S10 = 90%); it is fixed, and the run that showed it was discarded.
- Horizontal overflow from long hashes and from `1fr` grid tracks on mobile.
- Validation errors appeared above the fold; focus now moves to the first invalid field.
- The contract-rejection message was not scrolled into view after submit.
- `run.sh` could not print the contract address when `PL_DATA_DIR` was an absolute path.
- After Ctrl+C or TERM, `run.sh` printed spurious "stopped unexpectedly" messages because the signal trap did not exit. Fixed, and the smoke test now asserts a clean message.
- `run.sh` failed with `RPC_URL…: unbound variable` in shells without a UTF-8 locale (`LANG` unset). Bash read the `…` after `$RPC_URL` as part of the variable name. Fixed by making the script ASCII-only and bracing that variable; verified with `LANG`/`LC_ALL` unset.
- Final check from a clean state: `node_modules`, `build`, `web/dist` and `data` were deleted, then `./run.sh` installed, compiled, deployed, seeded and served the app; `npm run integrity` verified 4/4 devices; and `npm test` passed 29/29 again.

## Limitations and incomplete items

- **Demo authentication only.** Identities are chosen through the `X-Demo-Actor` header, and the server holds every demo key. Per-party key custody is not implemented.
- **Single in-memory Hardhat node.** Each `./run.sh` starts a new chain and archives the previous off-chain state; earlier sessions cannot be resumed.
- **RQ2 (interpretability) has not been evaluated with users.** It remains a hypothesis.
- **Literature review is preliminary.** Only the four supplied sources were checked (metadata and abstracts), not their full texts.
- **Benchmark scope:** one machine and one sequential client; on-chain storage per record is computed from the struct layout; no significance testing.
- **Conflict detection** depends on submitters recording component assertions; evidence-reuse detection catches only byte-identical files.
- **Embedded PDF viewer:** the in-app browser pane rendered the PDF frame blank. An "Open in new tab" link is provided. Not checked in desktop Chrome or Safari.
- **Unbounded archive:** `data/archive/` grows with each restart. Delete old folders manually.
- **No contract audit.** No independent security review or audit has been done, and no compliance is claimed.
