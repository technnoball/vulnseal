# Presentation guide (≈ 10–12 minutes)

## Before the presentation

1. Open the project folder in a terminal and run all checks (takes about 15 s):

   ```bash
   npm test
   ```

   Expected result: `pass 29`, `fail 0`.
2. Start the app and leave the terminal open:

   ```bash
   ./run.sh
   ```

   This opens http://127.0.0.1:4600. Every run starts a fresh chain with fresh demo data, so start it just before you present. The device IDs (PL-XXXX-XXXX) change on every run; refer to laptops by name.
3. Have these open in tabs: the app, [docs/results/latest.md](docs/results/latest.md) and [contracts/PatchLedger.sol](contracts/PatchLedger.sol).
4. Optional backup: run `npm run benchmark -- --devices 10 --events 8` once, so you know it takes about 3 s.

## Concepts to be able to explain

| Concept | One-line answer |
|---|---|
| What problem? | Used laptops pass through several independent repair shops. Their repair histories can be incomplete, contradictory, or edited by whoever controls the database. |
| What does the blockchain prove? | **Who** recorded a claim, **when**, **which evidence file** (by hash), and that the history was **not altered afterwards**. It does **not** prove the claim is true; that limit is the *oracle problem*. |
| What is on-chain? | Only hashes and metadata: device key, record hash, previous hash, payload digest, actor address, timestamp, sequence, record type. No names, serial numbers or documents. |
| What is off-chain? | Full details in SQLite, and evidence files on disk. Their hashes are committed on-chain, so any edit is detectable. |
| Why "append-only"? | The contract has **no edit or delete function**. A correction is a new record that points to the old one, and the old one stays visible. |
| How are records linked? | Each record stores the previous record's hash, like a mini blockchain per laptop. To add a record you must quote the current latest hash, otherwise the contract rejects it with `StalePrevHash`. |
| Who enforces permissions? | The **smart contract** (roles: Registrar, Repairer, Inspector, Verifier/Buyer, Auditor). Hiding buttons in the UI would not be enough, so the UI lets you try and the contract rejects. |
| Dispute rules | A buyer, inspector or repairer can challenge someone else's claim. Only an **auditor** resolves it, and never the author of the claim or the challenger. |
| Hashes used | SHA-256 for evidence files. keccak256 (Ethereum's hash) for records, computed over a **canonical** (sorted-key, fixed-format) payload so the same data always gives the same hash. |
| Stack | Solidity 0.8.28, Hardhat (local chain), ethers.js, Node + Express, SQLite, React + Vite. Everything runs on 127.0.0.1. |
| Why not just a database? | See the benchmark: a database protected by hash chains catches edits, but the **database operator can still write records in someone else's name** or **fake an auditor's ruling**. With a blockchain each party signs with its own key, so it cannot. The cost is about 200× slower writes and gas. |

## Demo flow

**1. Overview (1 min)** — the *Ledger overview* page. The numbers come from the live chain and database. Point to the block height and the contract address at the bottom left.

**2. A clean passport (1.5 min)** — Device passports → **Dell Latitude 7490**:
- the battery diagnostic, the replacement with an invoice, receipt and photo, and the post-repair report;
- the "Independently corroborated" stamp;
- expand **Ledger commitment** on a record to show the record hash, previous hash, transaction and gas.

Click an evidence file → **Verify integrity now**: it recomputes the SHA-256 and compares it with the on-chain commitment.

**3. Record a new repair (2 min)** — set *Acting as* to **Kiran Bench Repairs**, then **Record new event** → Repair:
1. Fill in the fields.
2. Upload any small PDF, PNG or text file, then choose **Upload and hash**.
3. Choose **Commit**.

The new record shows "anchored on-chain". Optionally, switch to **Demo Buyer** and try to record a repair: the *contract* rejects it with `NotAuthorized`.

**4. Conflict + dispute (3 min)** — open **HP EliteBook 840 G5**:
- Record #002 says the battery was replaced, but #003 says "original battery": a conflict is flagged.
- The receipt is byte-identical to the Dell's receipt, which triggers a reuse warning (a recycled document).
- The buyer's challenge #004 is unresolved.

Then the resolution:
1. Go to the **Dispute centre** and, as **Demo Buyer**, try **Attempt resolution**. It is rejected on-chain.
2. Switch to **Open Audit Collective** (auditor) and resolve with "Claim rejected".
3. Back on the passport, the original claim, the challenge and the resolution are **all still visible**.

**5. Tampering (2 min)** — **Audit & export** → Tamper lab:
1. Choose a device and a record, then **Edit record in DB**. This simulates a dishonest database admin. The integrity check fails with `PAYLOAD_DIGEST_MISMATCH`.
2. Optionally, open the device's public verify page: it now says **ALTERED**.
3. Choose **Attempt on-chain rewrite**: three real transactions, all rejected by the contract.
4. Choose **Restore all**; integrity passes again.

**6. Public verification (30 s)** — scan the QR code on a passport, or open `/verify/<ID>`. It is a read-only page with no evidence contents or personal data.

**7. Research results (1.5 min)** — **Research benchmark** → Run (about 3 s). Explain the attack matrix:

- The blockchain caught or blocked 100% of the attacks in S1–S8.
- A plain editable database caught 0% of content edits.
- A hardened database with checkpoints matched the blockchain on rewrites, but all centralized versions failed **S7 (forging someone else's record)** and **S8 (hiding a dispute)**.

Then the trade-off: about 16 ms vs 0.07 ms per write, and about 135k gas per record.

**8. Close with the limitations (30 s)**:
- one local node, not a real multi-organization network;
- demo identities are chosen from a menu, and the server holds all keys;
- synthetic data, no user study.

Saying this yourself shows you understand the difference between a prototype and production.

## Likely questions

- **"Can't the repairer just lie?"** Yes. A blockchain cannot verify physical reality (the oracle problem). The system makes the lie **attributable, challengeable and permanent**, and evidence categories show how well-supported each claim is.
- **"Why not store the files on-chain?"** It would be expensive (gas per byte), the files are private, and they could never be deleted. Only their hashes go on-chain.
- **"Is this Ethereum mainnet?"** No. It is a local Hardhat development chain with public test keys and no real money. A real deployment would use a permissioned network shared by repair shops, refurbishers and auditors.
- **"What stops the admin from creating fake auditors?"** Nothing in this prototype; that is a documented risk. The fix is multi-signature or governance-controlled role grants. See [docs/threat-model.md](docs/threat-model.md).
- **"What is gas?"** The computation cost of a transaction. One record costs about 135,000 gas. That is free on the local chain, but it would cost money on a public chain.
- **"How is this different from existing work?"** Blockchain product passports already exist (Wan & Jiang 2025; Abreu et al. 2025). The contribution here is the combination of evidence categories, conflict detection, append-only corrections and on-chain dispute rules, together with a fair measured comparison against hardened databases. See [docs/research-gap.md](docs/research-gap.md).

## If something goes wrong

- **Port busy:** the script picks another port and prints it. Use the printed URL.
- **"Ledger node unavailable":** press Ctrl+C and run `./run.sh` again.
- **Nothing works at all:** run `npm test` to confirm the code is fine. The logs are in `data/logs/`.
