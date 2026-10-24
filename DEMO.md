# VulnSeal — presentation guide (≈ 12 minutes)

## Before you present

1. Confirm the code works. You should see `pass 38`, `fail 0`, in about 20 seconds:

   ```bash
   npm test
   ```

2. Start a fresh, seeded ledger and leave the terminal open:

   ```bash
   ./run.sh --reset
   ```

   The app opens at http://127.0.0.1:4700.

3. Optional: in a second terminal, watch the chain live:

   ```bash
   npm run ledger -- --watch
   ```

## Concepts to be able to explain

| Question | Answer |
|---|---|
| What problem? | Overlapping bug reports sent to *different* programs have no shared, trustworthy timeline or dispute record. Each platform's log is controlled by its own operator. |
| What goes on-chain? | Only a commitment hash, the pseudonymous researcher address, the program id, the policy version, block time, status changes, salted digests of rationales, and decision codes. Never the report, the evidence or the nonce. |
| What is a commitment? | `keccak256(domain, chainId, contract, researcher, program, policyVersion, fieldsDigest, nonce)`. Each report field is hashed separately, and a 256-bit secret nonce hides even short reports. It binds the researcher to the content without revealing it. |
| What does a reveal prove? | That the shown report and nonce reproduce the earlier commitment, so the report wasn't changed after committing. An altered reveal is detected and the mismatch stays on-chain forever. |
| What does it *not* prove? | That the report is true, valid, or first discovered in the real world. Block time is not a trusted clock, and arbitrators can still be wrong. |
| Who enforces the rules? | The smart contract. It checks roles, the program each actor belongs to, the state machine, that the *other* program reviews an association, conflict-of-interest recusal, 2-vote decisions, and fresh-panel appeals. |
| Why not a database? | The benchmark is fair about this. A hash-chained, signed log with external checkpoints also detects rewrites. Only per-party keys enforced on-chain stop the operator forging a vote or review in someone else's name. |
| What is the cost? | Measured: about 19 ms against about 0.35 ms per commit, about 166k gas per commit, and more metadata visible to every participant (e.g. the same pseudonym is linkable across programs). |

## Demo flow

1. **Overview (1 min).** Every number comes from the contract and the store. Point out the block number and the contract address in the sidebar.
2. **Demo scenario (4 min).** Press *Run step* repeatedly:
   - step 4: an altered reveal is caught;
   - step 7: self-approval is rejected;
   - step 10: a conflicted arbitrator and a program admin are rejected by the contract;
   - steps 12–13: an appeal heard by a fresh panel.
   Each row shows the actor and the transaction hash.
3. **Open the scenario's reports (2 min).** Sign in as basalt and you see the sealed original. Switch to Tamarind triage and the content is withheld, though the ledger record is visible. Then *Verify the receipt against the chain*.
4. **Cross-program explorer (1 min).** Everything here is what every participant sees: no content, but linkage. Point out the issue-family token.
5. **Dispute page (1 min).** Show the round-1 decision kept alongside the appeal decision, each reason code, and the policy reference.
6. **Audit (2 min).** As the auditor:
   - **Run integrity check** → consistent;
   - in the tamper lab, **Rewrite a stored reveal** → run the check → `REVEAL_RECHECK_DIFFERS`;
   - **Attempt on-chain rewrites** → all rejected;
   - **Restore**.
7. **Research benchmark (1 min).** Show the scenario matrix. Rows S3, S8 and S10 separate the designs; S11 shows forged votes caught only by the blockchain. Then show the disclosure table.

## Likely questions

- **"Can't the reviewer lie about a reveal?"** Yes, the contract can't check the content without the nonce. But the reveal package lets anyone re-verify, and the audit re-checks stored reveals.
- **"Is the timestamp proof of discovery?"** No. It shows that the commitment existed by that block. A researcher who found the issue earlier but committed later can't prove it.
- **"Are the hashes anonymous?"** Content yes, metadata no. Addresses link a researcher's submissions across programs, and family tokens reveal relatedness.
- **"How does it survive restarting?"** Every signed transaction is journaled and replayed into a fresh node. The test suite checks that every block hash is identical afterwards.
- **"How is this different from Vultron / FIRST / HackerOne?"** Those cover coordination and in-platform duplicates. VulnSeal adds a cross-program, commitment-based priority and arbitration record. See docs/research-gap.md.
