# Threat model

VulnSeal is a **research prototype on a single local development chain**. This document separates guarantees enforced by the smart contract or by cryptography from protections that exist only in the application, and it lists what remains unsolved (RQ4).

## Assets

- Integrity and ordering of report commitments.
- The binding between a later reveal and the earlier commitment.
- Confidentiality of report content, evidence, nonces, rationales and identity mappings.
- Integrity of triage, association and arbitration histories: who decided what, under which policy.
- Availability of the record to every participating program.

## Participants and adversaries

| Actor | Legitimate power | Adversarial goals considered |
|-------|-----------------|------------------------------|
| Researcher | Commit, reveal, revise own reports; grant disclosure; dispute; appeal | Change a report after committing; claim earlier priority; reveal a better report than the one committed; copy another researcher's commitment |
| Program admin / triage reviewer | Acknowledge, request reveal, verify, triage, finalise; propose and review associations; publish policies | Read another program's reports; approve their own association proposal; falsely record a reveal outcome; overturn a decision |
| Arbitrator | Vote, recuse | Decide a dispute involving an affiliated program; vote twice; sit on the appeal of their own decision |
| Auditor | Read the ledger and run the integrity check; attest | (assumed honest; read-only on content) |
| Consortium governor | Register programs and participants | Create sybil arbitrators; grant roles to accomplices |
| **Operator of the off-chain store** (server insider) | Database, evidence store, vault key | Rewrite or delete stored records; forge receipts; backdate submissions; hide failed reveals or disputes; forge votes |
| External observer of the chain | Read every transaction and event | Learn report content, link pseudonyms, infer relationships |

## Attacks and where each is stopped

| Attack | Contract or crypto guarantee | Application-only protection | Residual risk |
|--------|-----------------------------|-----------------------------|---------------|
| Alter a report after committing, then reveal it | The commitment binds the content (keccak256 over field hashes) | The reveal check classifies it as a mismatch | None, given the hash assumptions |
| Reveal with a different nonce, program, policy or researcher | All are bound into the commitment | — | — |
| Copy someone else's commitment (front-running) | The researcher address is inside the hash, so the copier cannot open it (`verifyOpening` is false); same-address replay is rejected | — | The copy is still recorded under the copier's address (a griefing nuisance, not priority theft) |
| Edit or delete an anchored commitment | No such function exists; revisions create new records (`reviseCommitment`) | — | — |
| Hide a failed reveal | The `mismatches` counter and log entry are on-chain and never decrease | The audit flags a deleted mirror (`MIRROR_EVENT_MISSING`) | — |
| Skip process steps (reveal before request, triage before reveal) | State-machine checks (`InvalidTransition`) | The service refuses an early reveal before any disclosure | — |
| Wrong role or wrong program acts | Role bitmask plus program affiliation (`NotAuthorized`, `WrongProgram`) | — | Governor compromise (below) |
| Proposer approves their own association | `ProposerCannotReview`, and the review must come from the other program | — | Two colluding programs |
| Conflicted arbitrator decides | `ConflictedArbitrator` (affiliation with an involved program), `PartyCannotVote`, `AlreadyVoted`; one vote per address per round | — | Undeclared conflicts; sybil arbitrators |
| Appeal judged by the same panel | `PriorPanelMember` | — | Small arbitrator pool |
| Decision rewritten after the fact | Decisions, both rounds and all votes are on-chain; nothing is overwritten | The audit flags edited mirrors (`DISPUTE_MIRROR_ALTERED`) | — |
| Operator forges a vote or review in someone's name | Needs that party's key | — | **The prototype server holds all demo keys** (see below) |
| Operator backdates a receipt | Block time and position come from the chain, and the receipt verifier checks them | — | Whoever produces blocks controls timestamps (here, one node) |
| Off-chain record tampering (reports, reveals, evidence, rationales, event mirror) | The digests they must match are on-chain | Audit codes: `REPORT_COMMITMENT_MISMATCH`, `REVEAL_RECHECK_DIFFERS`, `EVIDENCE_ALTERED`, `RATIONALE_ALTERED`, `MIRROR_EVENT_MISSING` | Detection only, not prevention, for off-chain data |
| ID-guessing (IDOR) on report, evidence or recovery routes | — | Server-side `contentAccess`, owner-only recovery, cookie-bound identity; tested | — |
| Stored XSS through evidence | — | Downloads only (`Content-Disposition: attachment`), `nosniff`, sandbox CSP, MIME allowlist | — |

## Trust assumptions and unsolved problems (RQ4)

1. **False reports.** A commitment proves that content was committed, not that it is true. Validity is decided by human triage and, if disputed, by arbitration.
2. **Discovery time.** The ledger shows when a commitment was *recorded*, not when the issue was found. A researcher who discovered something earlier but committed later has no cryptographic proof of that.
3. **Unreliable timestamps.** Block time is set by block producers. On the local node, Hardhat's strictly increasing timestamps were observed running about a minute **ahead** of wall-clock time after bursts of transactions. Ordering by block number and log sequence is reliable; absolute time is approximate. Block time is not a substitute for a trusted timestamping authority (e.g. RFC 3161).
4. **Dishonest adjudication.** Arbitrators can decide wrongly. The contract enforces who may decide and how many must agree, and keeps reasoned, attributable records. It cannot make a judgement correct.
5. **Dishonest reveal attestation.** The contract cannot check a `MATCH` record without the nonce. A colluding reviewer could record a false match. Anyone holding the reveal package can re-check it, and the audit re-checks stored reveals.
6. **Identity abuse.** Researchers self-register pseudonymously, so one person can create many addresses. The governor registers programs and arbitrators, so a compromised governor can create sybil arbitrators or affiliations. Production would need multi-signature governance and real onboarding.
7. **Key custody.** The **demo server generates and holds every participant's key**, encrypted with the local master key, so the UI can act as anyone. This lets a server operator act as any party, which defeats the multi-party guarantees. In a deployment each party signs with its own wallet or HSM. The benchmark models that intended deployment: the insider does not hold other parties' keys.
8. **Metadata leakage.** Every network participant sees:
   - which pseudonym committed to which program, and when;
   - the status history and reveal outcomes;
   - which submissions share an issue family;
   - who voted how, by decision code.

   The benchmark measured that all three demo researchers are linkable across programs. Hashes do not hide linkage.
9. **Relationship detection.** Hidden commitments cannot reveal that two reports concern the same vulnerability. VulnSeal relies on reviewers who read both (after disclosure grants). A privacy-preserving matching protocol (e.g. PSI) is not implemented.
10. **Single local node.** There is no decentralisation, no consensus and no replication. Whoever runs the node could rebuild the chain differently. The journal makes the ledger durable for the demo, but it does not make it trustworthy against its operator.
11. **Simulated authentication.** The identity selector issues an HMAC-signed cookie with no password, binds only to 127.0.0.1, and has no CSRF tokens beyond `SameSite=Strict`. It is not production authentication.
12. **Vault key on the server.** Report contents are encrypted at rest with a key stored beside them (`data/keys/master.key`, mode 0600). This protects copies of the database or evidence files, not a compromised server. A real design would keep the researcher's vault client-side.

## Privacy summary

- **On-chain:** commitment hashes, salted digests, pseudonymous addresses, program ids, policy digests, timestamps, state transitions, decision and reason codes, issue-family tokens.
- **Never on-chain:** report text, nonces, file names, evidence, rationales, payout identities. The benchmark scanned all transaction input and logs and found 0 of 40 report markers and 0 of 256 nonces; the same search found 40 of 40 commitment hashes as a positive control.

## Prototype versus production

| Concern | Prototype | Needed for production |
|---------|-----------|-----------------------|
| Network | Single in-memory Hardhat node plus journal replay | Permissioned network run by several organisations, or a public chain; monitoring |
| Keys | Generated and held by the server | Per-party wallets or HSMs; rotation and revocation |
| Authentication | Simulated sign-in | Real authentication and organisational onboarding |
| Governance | One governor account | Multi-signature or on-chain governance |
| Confidential storage | Server-side vault, one master key | Client-side encryption, per-party keys, retention policy |
| Contract | Unaudited | Independent audit; upgrade and migration plan |
| Legal and process | Fictional policies | Agreed shared policy, dispute rules, data-sharing agreements |

**No security certification, audit, compliance, user study or production deployment is claimed.**
