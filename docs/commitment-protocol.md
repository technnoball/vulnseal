# Commitment protocol (v1)

This is the exact construction implemented in [`server/commitment.ts`](../server/commitment.ts) and mirrored in [`contracts/VulnSeal.sol`](../contracts/VulnSeal.sol) (`computeCommitment`, `verifyOpening`). The test suite checks that the TypeScript and Solidity encodings produce identical commitments.

## 1. Goals

- **Binding:** after anchoring, the researcher cannot open the commitment to different report content, a different program or a different policy version.
- **Hiding:** the commitment, the receipt and every on-chain record reveal nothing about the report text, even when the report is short or predictable. This rests on a 256-bit secret nonce.
- **Unambiguous:** two different reports can never produce the same encoding. There is no string concatenation, every field is hashed separately, and the encoding is fixed-width.
- **Versioned:** every tag carries `v1`. Changing the field list requires new tags and a new schema version.

## 2. Report fields (schema `vulnseal.report.v1`)

| # | Field | Encoding |
|---|-------|----------|
| 1 | `title` | `h(s) = keccak256(utf8(NFC(s)))` |
| 2 | `description` | `h(s)` |
| 3 | `impact` | `h(s)` |
| 4 | `reproduction` | `h(s)` |
| 5 | `scope` | `h(s)` |
| 6 | `severity` (low/medium/high/critical) | `h(s)` |
| 7 | `evidence` (SHA-256 of each evidence file) | `evidenceRoot = keccak256(abi.encode(bytes32[] sorted, lower-case digests))` |

The server trims text fields before committing. The reveal package carries the trimmed values.

**Why these fields:** they are the claims a priority or validity decision depends on — what the issue is, where, how bad, how to reproduce it, and what supported it.

**Not committed:**

- the researcher's private notes, which are stored separately and never revealed;
- file names, which can be sensitive, so only digests are committed;
- the researcher's own claimed discovery time, because a self-asserted time adds no evidence. The anchoring block time is what the ledger records.

## 3. Fields digest

```
REPORT_TAG   = keccak256("VulnSeal.Report.v1")
fieldsDigest = keccak256(abi.encode(
    bytes32 REPORT_TAG,
    bytes32 h(title), bytes32 h(description), bytes32 h(impact),
    bytes32 h(reproduction), bytes32 h(scope), bytes32 h(severity),
    bytes32 evidenceRoot))
```

Every component is a fixed 32-byte word in a fixed position. Moving text from one field into another changes the digest (tested).

## 4. Commitment

```
nonce        = 32 bytes from node:crypto randomBytes   (secret, never on-chain, never logged)
COMMIT_DOMAIN = keccak256("VulnSeal.Commitment.v1")
commitment   = keccak256(abi.encode(
    bytes32 COMMIT_DOMAIN,
    uint256 chainId,
    address contract,
    address researcher,
    uint32  programId,
    uint32  policyVersion,
    bytes32 fieldsDigest,
    bytes32 nonce))
```

- `chainId` and `contract` stop a commitment from being replayed on another deployment.
- `researcher` is the anchoring address. A copied hash anchored by someone else cannot be opened by them (tested), and the contract rejects re-anchoring the same hash from the same address (`ReplayedCommitment`).
- `programId` and `policyVersion` bind the report to the programme and rules it was submitted under. The contract only accepts the program's **current** policy version (`StalePolicy`).

## 5. On-chain anchoring

`anchorCommitment(commitment, programId, policyVersion)` must be called by an address holding the researcher role. The contract stores the following, in 5 storage slots:

- `commitment`, `researcher`, `programId`, `policyVersion`;
- `status`, `mismatches`, `anchoredAt` (block time);
- `supersedes` / `supersededBy`, `logSeq`;
- `revealDigest`, `family`.

It also appends a hash-chained log entry and emits `CommitmentAnchored`. No report text, nonce, file name or evidence ever enters a transaction.

**Revisions:** `reviseCommitment(oldId, newCommitment, policyVersion)` (owner only) anchors a **new** commitment with `supersedes = oldId` and marks the old one `supersededBy`. The original keeps its time and can still be opened. A revision does not inherit the original's priority.

## 6. Receipt (`vulnseal.receipt.v1`) — safe to share

```
reportRef, commitmentId, commitment, schema, commitDomain, researcher,
programId, programNameTag, policyVersion, policyDigest,
chainId, contract, txHash, blockNumber, blockHash, anchoredAt, anchoredAtIso,
logSeq, logEntryHash, supersedes, issuedAt,
statement { proves, doesNotProve }
```

Verification ([`server/receipt.ts`](../server/receipt.ts), `npm run verify-receipt`, `POST /api/verify/receipt`) needs only RPC access to a ledger node. It checks:

- the format;
- the chain id;
- that contract code is present;
- that the on-chain commitment, researcher, program, policy version, policy digest and anchoring time match;
- that the log position and log entry hash match;
- that the transaction succeeded, sits in the stated block with the stated block hash, and emitted `CommitmentAnchored` for this id and hash.

Possible results:

- `incomplete` — a required field is missing (lists them);
- `invalid` — a check failed (lists which);
- `valid`.

## 7. Reveal package (`vulnseal.reveal.v1`) — private

```
{ format, commitmentId, chainId, contract, researcher, programId, policyVersion,
  report: { schema, title, description, impact, reproduction, scope, severity, evidence[] },
  nonce }
```

The **recovery package** is this structure plus the receipt and a warning. Only the researcher can download it.

- Anyone holding it can reveal the report.
- If it is lost and the server-side vault is also lost, the commitment can never be opened.

## 8. Reveal verification

`checkReveal(package, anchoredRecord)` returns exactly one of:

| Outcome | Meaning |
|---------|---------|
| `match` | The recomputed commitment equals the anchored one |
| `mismatch` | The package is well formed but opens to a different commitment (content, nonce, researcher, program or policy differ) |
| `missing` | The nonce, the report or a report field is absent |
| `invalid-encoding` | Wrong format or schema, a non-hex or short nonce, non-text fields, unexpected fields, or ids that contradict the anchored record |
| *(not yet revealed)* | No reveal has been submitted. Shown as a state, not as a check result |

The program's reviewer runs the check twice: locally, and through the contract's `verifyOpening(cid, fieldsDigest, nonce)`. The contract check is an `eth_call` executed by the reviewer's own node, **not a transaction**, so the nonce is never broadcast. The reviewer then records the outcome with `recordReveal(cid, outcome, revealDigest)`:

```
REVEAL_TAG   = keccak256("VulnSeal.Reveal.v1")
revealDigest = keccak256(abi.encode(bytes32 REVEAL_TAG, uint64 cid, bytes32 fieldsDigest, bytes32 nonce))
```

The nonce is inside the hash, so the published reveal digest cannot be used to test guesses about the content (added during documentation; tested).

**Mismatches are append-only:** each one increments `mismatches`, and a later matching reveal does not erase the count.

**Trust note:** the contract cannot check a `match` claim without the nonce. A dishonest reviewer could record a false outcome. The reveal package and the off-chain audit let anyone holding the package re-verify. See the threat model.

## 9. Other digests on-chain

- **Rationales, statements, triage notes:** `noteDigest = keccak256(abi.encode(NOTE_TAG, bytes32 salt, keccak256(utf8(NFC(text)))))` with a random 32-byte salt stored off-chain. The salt stops dictionary attacks on short texts such as "approved".
- **Log entry:** `entryHash = keccak256(abi.encode(LOG_DOMAIN, chainId, contract, uint64 seq, uint8 kind, uint64 subject, address actor, uint64 timestamp, bytes32 dataHash, bytes32 prevHash))`. The contract stores `logEntries[seq]` and `logHead`.
- **Issue family:** `keccak256(abi.encode(FAMILY_DOMAIN, chainId, contract, associationId))`, assigned only when a same-issue association is confirmed by the other program or decided by arbitration.

## 10. What a valid commitment does *not* establish

- that the report is true, reproducible, in scope or valid;
- when the researcher actually discovered the issue — only that the commitment existed by the block that recorded it;
- that the block time is accurate. On this single local node, block times are set by the node. Under bursts of transactions, Hardhat's strictly increasing timestamps were observed running about a minute ahead of wall-clock time;
- that two reports concern the same issue. Hashes of similar reports are unrelated, so association needs qualified human review (or a separately designed private-matching protocol, which is not implemented).
