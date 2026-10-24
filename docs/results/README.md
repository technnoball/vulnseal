# Benchmark results

All files here were produced by `scripts/benchmark.ts` on 24 Oct 2026 (Apple M4, macOS, Node v24.19.0, Hardhat 2.29.1, solc 0.8.28). Every run used 40 synthetic reports, 8 cross-program pairs and 12 trials per scenario.

| File | Run |
|------|-----|
| `benchmark-seed42-40r-…T08-23-34…` | Seed 42, from the CLI |
| `benchmark-seed7-40r-…T08-22-52…` | Seed 7, from the CLI |
| `benchmark-seed42-40r-…T08-35-12…` (= `latest`) | Seed 42 again, started from the web UI during the acceptance test |

Earlier development runs exposed a baseline modelling flaw (the checkpoint witness kept only the latest head) and missing per-trial isolation. Both were fixed and those runs were discarded before these were made.

## Measured performance (median; range over the three runs)

| Design | Commit ms (p95) | Commits/s | Transition ms | Reveal check ms | Receipt verify ms | Bytes/submission | Bytes/event |
|---|---|---|---|---|---|---|---|
| Editable SQLite | 0.32–0.45 (0.46–1.14) | 1,786–2,937 | 0.08–0.10 | 0.41–0.51 | 0.009–0.011 | 1,638 | 234 |
| Hardened log | 0.33–0.43 (0.42–0.70) | 2,159–2,738 | 0.09–0.11 | 0.35–0.44 | 0.06–0.07 | 3,584 | 512 |
| Hardened + checkpoints | 0.35–0.43 (0.45–0.66) | 2,123–2,739 | 0.10–0.12 | 0.37–0.43 | 11.5–12.2* | 3,584 | 512 |
| VulnSeal (local chain) | 18.9–20.1 (22.0–23.9) | 49–51 | 16.3–17.3 | 20.7–22.7 | 12.8–13.3 | 7,680–7,782 off-chain + 224 on-chain† | 991–1,004 off-chain |

\* Receipt verification for the checkpointed log replays the whole log against every witnessed checkpoint.
† Computed from the storage layout: a 5-slot struct, a replay-protection slot and a log-entry slot.

**Gas (median per operation; identical across runs):**

| Operation | Gas |
|---|---|
| `anchorCommitment` | 165,666 |
| `acknowledge` | 70,803 |
| `requestReveal` | 70,782 |
| `recordReveal` | 95,832 |
| `setTriage` | 73,684 |
| `proposeAssociation` | 151,751 |
| `reviewAssociation` | 144,333 |
| `openDispute` | 235,325 |
| `vote` | 140,559 |

Mean per transaction: 102,034. Deployment: 4,243,209. Calldata averages 84 bytes per transaction.

## Scenario outcomes (identical in all three runs; 12 trials each)

P = prevented, D = detected, U = undetected.

| Scenario | Editable | Hardened | Hardened + checkpoints | VulnSeal |
|---|---|---|---|---|
| S1 valid commit + matching reveal | 12/12 pass | 12/12 | 12/12 | 12/12 |
| S2 modified reveal | 12 D | 12 D | 12 D | 12 D |
| S3 operator rewrites the stored commitment | **12 U** | **12 U** | 12 D | **12 P** |
| S4 replacing an earlier commitment | **12 U** | 12 P | 12 P | 12 P |
| S5 same-issue association with independent review | 12/12 pass | 12/12 | 12/12 | 12/12 |
| S6 similar reports judged distinct, no auto-merge | 12/12 pass | 12/12 | 12/12 | 12/12 |
| S7 premature disclosure | 12 P | 12 P | 12 P | 12 P |
| S8 recorded decision changed | **12 U** | **12 U** | 12 D | **12 P** |
| S9 dispute + appeal, both rounds kept | 12/12 pass | 12/12 | 12/12 | 12/12 |
| S10 hiding a failed reveal | **12 U** | **12 U** | 12 D | **12 P** |
| S11 conflicted / duplicate / forged vote | 8 P, **4 U** | 8 P, **4 U** | 8 P, **4 U** | **12 P** |
| S12 missing / altered / backdated receipt | 9 D, **3 U** | 9 D, **3 U** | 12 D | 12 D |

## Disclosure (measured by inspection, seed-42 run)

- **Shared data:** the scan of every transaction input and log on the chain found **0 of 40** report markers and **0 of 256** nonces. The positive control — the same search for the 40 workload commitment hashes — found **40 of 40**.
- **Database files:** none of the four designs' database files contains report text in plaintext (0 of 40); content is sealed.
- **Metadata exposure:**
  - Blockchain: every consortium node sees all 256 commitments with times and programs. **3 of 3** researcher pseudonyms appear in more than one program, so they are linkable. Every node also sees 56 issue-family tokens and 44 disputes with decision codes.
  - Centralised designs: the same metadata is visible only to the operator.

## Interpretation (descriptive)

- **H1 supported.** Every design detects a modified reveal (S2): that comes from the commitment itself, not the ledger. Only the checkpointed log (detects) and the blockchain (prevents) resist an operator rewriting the stored commitment (S3).
- **H2 supported.**
  - The checkpointed log detects every rewrite of witnessed history (S3, S8, S10, S12).
  - All centralised designs accept an operator-forged vote in an arbitrator's name (S11, 4 of 12 trials are that attack). The operator can sign or insert anything.
  - Only per-party keys checked by the contract stop it.
  - The difference between "detected afterwards" (checkpoints) and "prevented" (blockchain) matters when a decision must be relied on before an audit runs.
- **H3 supported.**
  - About 19 ms per commit against about 0.35 ms, roughly 50 times slower, on an instantly-mining local node; real networks would add seconds.
  - About 2.2 times (versus the hardened log) to 4.7 times (versus the editable store) the off-chain bytes per submission, plus on-chain state and about 166k gas per commit.
  - Broad metadata exposure to every participant, including linkable pseudonyms.
- **Equal across designs:** S1, S2, S5, S6, S7 and S9 come from the commitment construction and from application rules that every design implements.
- **Limits:** one machine, a single-node chain, synthetic data, one attacker model, and descriptive statistics only. See [experiment-protocol.md](../experiment-protocol.md#threats-to-validity).
