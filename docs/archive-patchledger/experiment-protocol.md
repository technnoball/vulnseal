# Experiment protocol

This protocol defines the benchmark in [`scripts/benchmark.ts`](../scripts/benchmark.ts) and [`scripts/lib/baselines.ts`](../scripts/lib/baselines.ts), which addresses RQ1 and RQ3. RQ2 (interpretability) is **not** evaluated empirically; see [research-gap.md §6](research-gap.md#6-demonstrated-results-hypotheses-and-future-work).

## Systems compared

| ID | System | Integrity mechanism | Authorization |
|----|--------|---------------------|---------------|
| `editable` | Conventional CRUD SQLite | Evidence SHA-256 column; checks for gaps in sequence numbers. Corrections and dispute status are updated in place. | Application code, same rules as the contract |
| `hardened` | Append-only SQLite | `BEFORE UPDATE/DELETE` triggers; SHA-256 hash chain over canonical records; evidence digests inside hashed payloads | Application code, same rules |
| `hardened-anchored` | `hardened` plus external checkpoints | As above, plus the head hash and record count handed to an independent party after every write | Application code, same rules |
| `blockchain` | PatchLedger contract plus off-chain SQLite (the real application service) | Contract-enforced append-only links; payload digests on-chain; evidence digests in committed payloads | Solidity contract, with per-party keys |

The baselines are **deliberately not weakened**:

- They use the same role matrix (`authorize()` mirrors the contract).
- They use the same canonical serialization and SHA-256 evidence hashing.
- The hardened variants reject updates and deletes through triggers.

## Workload

- `--devices N` (default 10) and `--events E` (default 8) per device. Each device has one registration plus E events.
- Event mix (seeded): diagnostic 35%, repair 25%, component replacement 15%, inspection 17%, custody transfer 8%. About 8% of slots become corrections of an earlier claim by that claim's author.
- 40% of non-custody events carry one synthetic evidence file (1.5–6 KB, unique content).
- RNG: `mulberry32(--seed)`. The same workload is applied, in the same order, to all four systems.
- The blockchain system runs on a **dedicated throw-away Hardhat node** on a free port, so the demo ledger is untouched.

## Metrics

| Metric | Definition | Kind |
|--------|-----------|------|
| Insert latency | Wall-clock time of one application-path insert (`appendEvent` / `registerDevice` for blockchain, including canonicalization, signing, the RPC round trip, the receipt and the SQLite insert). Evidence upload is excluded for all systems. | **Measured** |
| Median, p95 | Linear-interpolated quantiles; p95 is reported only when n ≥ 20 | Measured |
| Throughput | Records ÷ sum of insert times, for a single sequential client | Measured |
| Verification latency | Full-history verification per device using each system's own verifier (blockchain: RPC reads, `verifyChain()`, local recomputation, evidence re-hash) | Measured |
| Off-chain storage per record | SQLite `page_count × page_size` after a WAL checkpoint, ÷ records. Evidence files are excluded. | Measured |
| On-chain storage per record | Contract storage slots written × 32 B ÷ records (4 slots per record, plus per-device and per-correction mapping slots) | **Computed from the storage layout** |
| Calldata per record | Transaction `data` length, from the node | Measured |
| Gas | `receipt.gasUsed` per record type; mean per record; deployment gas | Measured |
| Tamper detection rate | Over T trials per scenario: (prevented + detected) ÷ T | **Simulated attack, real execution** |
| Unauthorized-operation rejection rate | Scenario S6 | Simulated attack, real execution |
| Evidence integrity outcomes | Scenarios S4, S5, S9 | Simulated attack, real execution |
| Trace completeness / dispute preservation | S11 (original preserved after correction), S8 (dispute not hideable) | Simulated, real execution |

## Attack and integrity scenarios

Each trial **actually performs** the attack: SQL statements, file writes, or real transactions. It then runs **that system's own verifier**, classifies the outcome, and restores the state.

- **P (prevented):** the operation was rejected.
- **D (detected):** the operation succeeded but verification flags it.
- **U (undetected):** the operation succeeded and was not flagged.

| ID | Scenario | Attacker capability |
|----|----------|---------------------|
| S1 | Unauthorized modification of an existing record | DB admin edits a claim and recomputes that record's own digest/hash |
| S2 | Consistent history rewrite | DB admin edits a claim and recomputes all later hashes. On the blockchain system the attacker also tries an on-chain fork. |
| S3 | Deletion of an event record | DB admin deletes a row |
| S4 | Alteration of an evidence file | File-store write access |
| S5 | Evidence file and its stored digest replaced | DB and file-store access |
| S6 | Unauthorized role submits a record | Normal write path, wrong role or not the original author |
| S7 | Insider forges a record in an authorized party's name | Store operator without that party's key |
| S8 | Hide or overwrite an unresolved dispute | Store operator: status edit, forged auditor resolution, or deletion |
| S9 | Reuse of an evidence digest | Byte-identical file submitted for another device |
| S10 | Conflicting component-replacement claims | Replacement followed by an "original part" assertion |
| S11 | Correction preserves the earlier claim | Author corrects a claim through the normal path (P = original preserved) |

**Threat-model boundary.** The insider controls the off-chain database and files but **not other parties' private keys**. In the prototype the server holds all demo keys for convenience; the benchmark models the intended deployment, where each party holds its own key. Attacks on the chain node itself (reset, consensus capture) are out of scope for a single local node.

## Hypotheses

- **H1 (RQ1):** For an off-chain insider, the blockchain system detects or prevents ≥ 95% of S1–S8 attempts. The editable store detects < 50% of the content-editing attacks (S1, S2, S5).
- **H2 (RQ1):** The hardened store with external checkpoints is comparable to the blockchain system on S1–S3 but not on S7 and S8, which need per-party authorization.
- **H3 (RQ3):** Blockchain insert latency is at least two orders of magnitude higher than SQLite on the same machine, even with instant automining.

These are **descriptive** hypotheses checked against observed counts. No significance tests are run: the attack outcomes are largely deterministic given the mechanism, and the latency results come from one machine.

## Reproducing

```bash
npm run benchmark -- --devices 20 --events 10 --seed 42 --trials 20
npm run benchmark -- --devices 20 --events 10 --seed 7 --trials 20
```

Outputs go to `docs/results/benchmark-seed<S>-<N>x<E>-<timestamp>.{json,md}`, plus `latest.{json,md}`. The JSON records the configuration, Node/Hardhat/solc versions, CPU, workload mix, per-store statistics, per-scenario counts and notes. The Research page in the UI runs the same script, with smaller bounds.

To assess variability, repeat with several seeds and report the range across runs. Run-to-run latency differences on the same seed come from OS scheduling.

## Threats to validity

- **Single machine, single client, automining.** Real networks add block time and consensus delay, so blockchain latency here is a lower bound.
- Blockchain verification includes RPC and evidence re-hashing, while the SQLite verifiers run in-process. Verification latencies are not like-for-like.
- On-chain storage is analytic, not measured from node disk usage, and excludes indexes and receipts.
- Synthetic workload; the record type mix is assumed, not observed.
- Scenario outcomes depend on the attacker model chosen. A stronger attacker who holds keys, or a weaker one without admin rights, would change the results. Both the matrix and the notes state the model.
- The author of the benchmark also built the system (no independent replication).
