# Experiment protocol

This protocol defines the benchmark in [`scripts/benchmark.ts`](../scripts/benchmark.ts), which uses the baselines in [`scripts/lib/baselines.ts`](../scripts/lib/baselines.ts). It addresses RQ1–RQ3. RQ4 is answered analytically in [threat-model.md](threat-model.md).

## Designs compared

| ID | Design | Integrity mechanism | Authorisation |
|----|--------|---------------------|---------------|
| `editable` | Conventional editable SQLite submission record | Rows updated in place; an editable status log; unsigned receipts checked against the database | Application code, same rules as the contract |
| `hardened` | Hardened centralised log | Every event is an append-only entry (UPDATE/DELETE blocked by triggers) in a SHA-256 hash chain, **signed by the operator's Ed25519 key**; operator-signed receipts | Application code, same rules |
| `hardened-anchored` | Hardened log plus external checkpoints | As above, plus every new head is handed to an independent witness that **keeps all earlier heads** (like a transparency-log witness) | Application code, same rules |
| `blockchain` | VulnSeal | The real contract and service on a dedicated throw-away Hardhat chain | Contract; each participant signs with its own key |

**Fairness measures** (the baselines are not weakened):

- all four designs use the **same commitment construction** (field hashes, evidence root, 256-bit nonce);
- all seal report content with the **same AES-256-GCM vault**;
- all apply the **same role, transition, conflict and appeal rules**.

During development, the checkpointed baseline first kept only its latest checkpoint. That made it miss rewrites of history the witness had already seen. It was corrected to keep every checkpoint before any result was reported.

## Threat model for the experiment

- **Insider:** the operator of the record store. They have database and file access and the vault key, and for the hardened designs they also hold the log-signing key. They do **not** hold other participants' private keys.
- **Outsider or dishonest participant:** uses the normal write path (wrong role, conflicted arbitrator, a researcher altering a reveal).
- **Out of scope:** attacks on the chain itself (node operator rewriting blocks, consensus capture), because there is a single local node; and cryptographic breaks.

## Hypotheses

- **H1 (RQ1):** every design that keeps a commitment detects a modified reveal. Only designs whose record of the commitment is outside the operator's control (checkpointed log, blockchain) also resist an operator rewriting the stored commitment.
- **H2 (RQ2):** the checkpointed log matches the blockchain on detecting rewrites of witnessed history. Only the blockchain resists records forged *in another participant's name*, because that requires per-party signatures enforced outside the operator.
- **H3 (RQ3):** the blockchain design costs at least an order of magnitude more latency per write than SQLite, even on an instantly-mining local chain. It also discloses more metadata to more parties (commitments, linkage, decisions), while disclosing no report content or nonces.

These are checked descriptively against observed counts. No significance testing is done.

## Workload (seeded)

- `--reports N` (default 40) synthetic reports. Each has a random researcher (3) and a random program (3); 70% end valid and 30% invalid; each carries a unique marker `ref-<hex>` used by the disclosure scan.
- Per report: commit → acknowledge → request reveal → reveal (match) → triage pending → triage valid/invalid.
- `N/5` cross-program pairs: propose same-issue (program A staff) → review (program B staff) → priority dispute → two arbitrator votes.
- `mulberry32(--seed)` drives every random choice. The same workload runs against every design in the same order.

## Metrics

| Metric | Definition | Kind |
|--------|-----------|------|
| Commit latency | Compute commitment and seal content, then record it. For the blockchain this includes signing, the RPC round trip, waiting for the receipt and the database write. Receipt building is timed separately | **Measured** |
| Transition latency | One status change, association step or vote | Measured |
| Reveal-check latency | Reviewer verifies a reveal and records the outcome | Measured |
| Receipt verification latency | Verifier checks a receipt. Blockchain: about 12 RPC reads. Hardened: Ed25519 signature check plus hash recomputation, plus a full witnessed-checkpoint audit for the anchored variant. Editable: database comparison | Measured |
| Median, p95 | Linear-interpolated quantiles; p95 only when n ≥ 20 | Measured |
| Throughput | Commits ÷ summed commit time, one sequential client | Measured |
| Storage | SQLite `page_count × page_size` after a WAL checkpoint, ÷ submissions and ÷ events. Blockchain on-chain bytes per submission come from the storage layout (7 slots) | Measured / **computed** |
| Gas | `receipt.gasUsed` per contract function | Measured |
| Scenario outcomes | Per trial: **P** prevented (the attacker's goal was rejected), **D** applied but detected by the design's own verifier, **U** applied and undetected. Functional scenarios: pass/fail | **Simulated attack, real execution** |
| Disclosure | A byte scan of each design's stored data and of *all* transaction inputs and logs on the chain for report markers and nonces, with commitment hashes as a positive control; plus counts of linkable pseudonyms, family tokens and disputes | Measured by inspection |

## Scenarios

| ID | Scenario | Attacker / actor |
|----|----------|------------------|
| S1 | Valid commitment followed by a matching reveal | Honest (functional) |
| S2 | Reveal containing modified report material | Researcher |
| S3 | Operator rewrites a stored commitment so a modified reveal is accepted | Operator colluding with the researcher |
| S4 | Attempted replacement of an earlier commitment | Researcher via the normal path |
| S5 | Same-issue association by qualified reviewers, with self-review refused | Functional |
| S6 | Similar-looking reports classified distinct; nothing auto-merged | Functional |
| S7 | Content disclosed before the process permits (early read, early reveal) | Reviewer and researcher |
| S8 | Unauthorized change of a recorded decision | Operator |
| S9 | Dispute followed by a valid appeal; both rounds retrievable | Functional |
| S10 | Hiding an earlier status event (a failed reveal) | Operator |
| S11 | Conflicted or compromised adjudicator. Rotates: conflicted arbitrator; duplicate vote; operator-forged vote | Mixed |
| S12 | Receipt with missing or mismatched information. Rotates: missing field; altered commitment; holder backdating; operator-issued backdated receipt | Mixed |

Each insider trial on a hardened log is **isolated**: the log and witness are snapshotted and restored, so one trial's damage cannot affect another's audit. On the blockchain design, off-chain edits made in the tamper lab are restored after each trial.

## Reproducing

```bash
npm run benchmark -- --reports 40 --seed 42 --trials 12
```

```bash
npm run benchmark -- --reports 40 --seed 7 --trials 12
```

Each run writes `docs/results/benchmark-seed<S>-<N>r-<timestamp>.{json,md}` and `latest.{json,md}`. The Research page in the UI runs the same script, with bounds on its parameters. Twelve trials cover S11's three and S12's four rotating attack types evenly.

## Threats to validity

- One machine, one sequential client, and a local node that **automines instantly**. Real networks add block and consensus latency, so blockchain latency here is a lower bound.
- Blockchain receipt verification includes RPC calls; centralised verification is in-process.
- On-chain storage per submission is computed from the layout, not measured on disk.
- The synthetic workload's shape (pairs, dispute rate) is assumed.
- Outcomes depend on the attacker model: an insider holding all keys would defeat the blockchain design too, as the prototype's server-held keys would.
- The same author built the system and the baselines; there is no independent replication.
