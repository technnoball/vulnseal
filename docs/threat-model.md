# Threat model and security assumptions

PatchLedger is a **research prototype on a single-node local development chain**. This document separates guarantees enforced by the smart contract from protections that exist only in the demonstration application.

## Assets

- Integrity and ordering of each device's repair history.
- Attribution: who made each claim.
- Visibility of disputes and corrections.
- Integrity of evidence files.
- Privacy of customers, evidence contents and hardware serial numbers.

## Actors and adversaries

| Actor | Legitimate capability | Adversarial goal considered |
|-------|----------------------|-----------------------------|
| Registrar / administrator | Register devices, record custody, grant and revoke roles | Grant roles to accomplices; register fake devices |
| Independent repairer | Diagnostics, repairs, replacements; correct their own claims | Inflate or fabricate repairs; remove inconvenient records; resolve disputes about their own work |
| Refurbisher / inspector | Inspections, corroboration, custody | Claim "original parts" after a replacement; corroborate their own claims |
| Buyer / verifier | Read history; raise challenges | Frivolous challenges; settling a challenge in their own favour |
| Auditor | Resolve disputes; correct or attach evidence | Collusion; resolving a dispute they raised |
| Database / file-store insider (operator of the off-chain store, compromised reseller) | Direct SQL and filesystem access | Edit, delete or forge records; swap evidence; hide disputes |
| Outsider | None | Any write |

## Attack scenarios and where each is stopped

| Attack | Contract guarantee | Application-only protection | Residual risk |
|--------|-------------------|-----------------------------|---------------|
| Edit or delete an existing record | **No edit or delete function exists**; records are only appended. A replacement must quote the current head (`StalePrevHash`). | — | Off-chain detail can be edited, but the integrity checker detects it through the payload digest. |
| Forge a record in another party's name | **`msg.sender` is the actor**; it cannot be forged without that party's key. | — | **In this demo the server holds all demo keys**, so a compromised server could sign as anyone. A production deployment needs per-party custody. |
| Unauthorized role writes (buyer records a repair, outsider writes) | **Role bitmask checked per record type** (`NotAuthorized`). | The UI warns beforehand but still sends the transaction, to show the contract enforcing the rule. | Admin compromise (below). |
| Repairer resolves a dispute about their own claim | **`SelfResolution`**, even if they also hold `AUDITOR`. | — | Collusion between distinct accounts is not prevented. |
| Challenger resolves their own challenge | **`ConflictOfInterest`** | — | Same as above. |
| Self-corroboration or self-challenge | **`SelfCorroboration` / `SelfChallenge`** | — | Sybil identities, if the admin grants them. |
| Hide an unresolved dispute | **Open-dispute state lives in the contract**; only an `AUDITOR` resolution clears it, and the challenge record stays. | Deleting the off-chain copy is flagged by the integrity checker. | — |
| Overwrite a claim through a "correction" | **Corrections are new records** referencing the target; one correction per target (`AlreadySuperseded`); only the author or an auditor may correct. | — | — |
| Swap an evidence file | The SHA-256 is inside the on-chain-committed payload. | Re-hash on view, on demand, and in the integrity checker. | Detection, not prevention. Files are not replicated, so deletion means loss. |
| Reuse a receipt across devices | — | Digest-reuse warning at upload and on the passport. | Only byte-identical copies are caught; a rescanned copy is not. |
| Contradictory component claims | — | Component-lineage conflict detection. | Depends on submitters recording component assertions. |
| Fork history by building on an old head | **`StalePrevHash`** | Clients pass `expectedPrevHash` from the page they saw. | — |
| Malicious SVG/HTML evidence (XSS) | — | Evidence served with `nosniff`. SVG and text are served with `Content-Security-Policy: sandbox`. Images use `<img>`. The app uses a strict CSP. | Browser PDF viewers are trusted. |
| Path traversal or oversized uploads | — | Server-generated file names, a MIME allowlist and a 10 MB limit. | — |

## Trust assumptions

1. **Oracle problem.** The ledger records *claims*. A matching digest shows a file is unchanged since submission, not that it is genuine or that the work happened. An authorized party can still record a false claim; the system makes that claim attributable, challengeable and permanently visible, not false-proof.
2. **False source claims.** Corroboration means an *independent* authorized party recorded supporting evidence. It is not a certification.
3. **Administrator compromise.** The admin can grant roles, including creating sock-puppet auditors. Mitigations, not implemented: multi-signature or governance-controlled admin, and role grants that need several organizations.
4. **Key compromise.** A stolen key can sign valid records until it is revoked. Records signed before revocation remain, and the history makes them visible. Production needs per-party wallets or HSMs and a revocation process.
5. **Demo identity selection.** The `X-Demo-Actor` header and the evidence `?as=` parameter are **not authentication**. Anyone who can reach the local server can act as any identity. This is acceptable only because the server binds to `127.0.0.1`.
6. **Local blockchain limitations.**
   - One Hardhat node with in-memory state: no consensus, no replication, no Byzantine fault tolerance.
   - Whoever controls the node can reset it. Every `./run.sh` starts a new chain and archives the previous off-chain data under `data/archive/`.
   - The guarantees above therefore hold *relative to an honest node*. A real deployment would use a permissioned network run by several independent organizations (or a public chain), so that no single operator can rewrite or censor history.

## Privacy

- On-chain data contains no names, contact details, addresses, serial numbers or document contents. Device keys are hashes of random public IDs.
- Payload digests include a random 128-bit nonce, so low-entropy payloads cannot be confirmed by guessing.
- Evidence contents are restricted: by default only the uploader, registrar, inspector and auditor can view them. "Shareable" opens them to registered verifiers.
- The public verification page shows only structured fields, evidence *categories* and integrity results. It shows no free text, file names or contents.
- Free-text fields could still contain personal data if a user types it in. The forms warn against this; nothing enforces it.
- Public chains are permanent. Even digests of personal data would raise erasure questions (for example under India's DPDP Act 2023). This prototype makes no compliance claim.

## Prototype versus production

| Concern | Prototype | Production would need |
|---------|-----------|------------------------|
| Network | Single in-memory Hardhat node | Permissioned multi-organization network or a public L2; monitoring |
| Keys | Public Hardhat test mnemonic, held by the server | Per-party wallets or HSMs, rotation, revocation |
| Identity | Header-selected demo identities | Organizational onboarding, authentication, KYC of businesses |
| Admin | Single EOA | Multi-signature or governance |
| Evidence storage | Local directory | Replicated, access-controlled storage; retention policy |
| Contract | Unaudited | Independent security audit; upgrade and migration plan |
| Legal | None | Privacy assessment, consent and data-sharing agreements |

**The demo keys come from the public Hardhat test mnemonic (`test test … junk`). Never use them on any public network.** No security certification, audit or regulatory compliance is claimed.
