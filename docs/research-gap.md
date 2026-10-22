# Research gap: evidence-aware, dispute-resolvable repair passports

**Full title:** *Evidence-Aware and Dispute-Resolvable Blockchain Repair Passports for Refurbished Laptops in India's Multi-Repair Ecosystem*

This is a **preliminary** literature review. It starts from four sources named in the project brief. I checked their bibliographic metadata against Crossref and read their publisher or repository abstracts. I have **not** read the full text of the three journal articles, so this document does not rely on any detail beyond those abstracts. See [Limitations of this review](#limitations-of-this-review).

## 1. Problem

A second-hand laptop in India may pass through several independent repairers, refurbishers and resellers before it reaches a buyer. Each party may keep its own records, or none. When histories conflict, a buyer usually cannot tell:

- who made a claim,
- when the claim was recorded,
- whether the claim was later changed or quietly deleted,
- what evidence was offered for it.

Two examples: a seller says "original battery" after a repairer has replaced it, or a database owner edits an inconvenient entry.

A blockchain **cannot** establish that a claim about the physical world is true. This is the oracle problem. What it can provide is tamper-evident provenance for *claims*: who recorded what and when, which evidence file (by digest) was cited, and whether the recorded history changed afterwards. PatchLedger is built around this distinction.

## 2. Related work (verified metadata)

| # | Reference | What the abstract establishes | Relevance |
|---|-----------|-------------------------------|-----------|
| 1 | Wan, P. K. F., & Jiang, S. (2025). Enabling a dynamic information flow in digital product passports during product use phase: A literature review and proposed framework. *Sustainable Production and Consumption*, 54, 362–374. https://doi.org/10.1016/j.spc.2025.01.014 | A systematic review of 25 DPP frameworks (data carriers, data sources, security, user access and verification). The review finds little support for **third-party maintenance updates after a passport has been issued**. It proposes a **conceptual blockchain-based DPP framework in which verified users such as repairers update lifecycle information**. Open issues it names: data-carrier security and information overload. | The closest prior work. **Blockchain DPPs with repairer updates in the use phase have already been proposed**, so PatchLedger cannot claim that idea as new. |
| 2 | Abreu, H., Pereira, V., & Barata, J. (2025). Blockchain-based digital product passport: design principles and demonstration. *International Journal of Production Research*, 63(16), 5863–5882. https://doi.org/10.1080/00207543.2025.2464161 | A two-year design-science study that builds an end-to-end blockchain DPP prototype for the **textile** supply chain. It derives **eleven design principles** and maps information flow across the life cycle. Its emphasis is upstream traceability of physical transformations and downstream access for stakeholders. | Shows that working blockchain DPP prototypes and design principles exist. Its domain is textiles and its focus is supply-chain traceability, not disputes about repair claims. |
| 3 | Corwin, J. E. (2018). "Nothing is useless in nature": Delhi's repair economies and value-creation in an electronics "waste" sector. *Environment and Planning A: Economy and Space*, 50(1), 14–30 (online 2 Nov 2017). https://doi.org/10.1177/0308518X17739006 | An ethnographic account of Delhi's e-waste economy that places it **within reuse, repair and remanufacturing** rather than in waste management. Traders and repair workers create value from devices in many different conditions and configurations. | Supports the premise that Indian electronics pass through **many independent repair actors** handling heterogeneous, re-configured devices. This is the setting where repair histories fragment. It is not a source on record-keeping technology. |
| 4 | UN/CEFACT. UN Transparency Protocol (UNTP), Digital Product Passport specification. https://untp.unece.org/docs/specification/DigitalProductPassport/ (served by the mirror at spec-untp-fbb45f.opensource.unicc.org) | The DPP is a lightweight **W3C Verifiable Credential** issued per item or batch. It links to **Digital Conformity Credentials**, which an independent auditor or certifier issues, and to **Digital Traceability Event** credentials based on EPCIS. Buyers can compare self-declared claims with independent assessments. The 0.6.0 and 0.7.0 versions differ in their event taxonomy. | Provides vocabulary for *self-declared versus independently assessed* claims. PatchLedger's evidence categories mirror that split. UNTP is credential-based; I did not confirm from the spec whether it requires any particular ledger. |

## 3. What is already covered

The following are **not** novel:

- Blockchain-backed digital product passports (refs 1 and 2, plus a wider literature not surveyed here).
- Letting verified repairers append use-phase information (ref 1, conceptual).
- Separating self-declared claims from independent conformity assessment (ref 4).
- Hash-chained, append-only logs and signed checkpoints. These are established techniques in transparency logs and audit logging.

## 4. Gap addressed by PatchLedger

The differentiation is **narrow and combinational**. PatchLedger treats the following together in one working, measured system for multi-party laptop repair:

1. **Evidence-classified claims.** Each claim carries an explicit evidence status: self-reported, evidence-attached (SHA-256 digest committed and re-verifiable), independently corroborated (by a *different* authorized party with its own evidence), disputed, or corrected/superseded. A file hash is never presented as proof of truth.
2. **Conflicting repair events.** Component-lineage checks flag contradictions. An example is a battery recorded as replaced and later asserted to be original.
3. **Append-only corrections.** A correction references the claim it supersedes. The original stays visible.
4. **Dispute resolution with separation of duties enforced on-chain.** A challenge can only be raised by a party who is not the claim's author. Only an auditor can resolve it, and that auditor can be neither the claim's author nor the challenger, even if the auditor holds other roles.
5. **Privacy by construction.** Opaque device keys, payload digests with random nonces on-chain, details and files off-chain, and evidence content restricted by role.
6. **A measured comparison with centralized alternatives that are not weakened.** The baselines are an editable SQLite store, a hardened append-only hash-chained store, and the same hardened store with externally held checkpoints. All of them use the same role logic.

The abstracts of refs 1 and 2 do not report dispute workflows, evidence-strength classification, conflict detection or a quantitative comparison with hardened centralized stores. Without the full texts this is **an observation from the abstracts, not a verified absence**.

## 5. Research questions

- **RQ1.** How effectively can the system detect unauthorized changes, deletions and conflicting histories?
- **RQ2.** How does explicit evidence classification and dispute handling improve the interpretability and auditability of repair records?
- **RQ3.** What are the latency, storage and verification trade-offs between blockchain and centralized record-keeping?

## 6. Demonstrated results, hypotheses and future work

**Demonstrated** by the prototype and its benchmark on one machine, local chain, synthetic data. See [`results/README.md`](results/README.md).

- *RQ1:* Against an insider who controls the off-chain store but not other parties' keys, the contract-backed design detected or prevented every simulated modification, deletion, evidence swap, forged attribution and dispute-hiding attempt (100% in S1–S8).
  - Editable SQLite detected none of the content edits.
  - Hardened SQLite with external checkpoints matched the chain on rewrites and deletions.
  - All centralized variants failed on forged attribution (S7) and dispute hiding (S8): 0%.
- *RQ3:* Inserting a record cost about 16 ms (median) on the automining local chain, against about 0.07–0.10 ms for SQLite. Throughput was about 62 versus about 9,000–13,000 records/s for one sequential client. A record used about 135k gas and about 133 B of contract storage, plus about 1.2 KB off-chain.

**Hypotheses, not tested:**

- *RQ2:* Explicit evidence categories and preserved dispute trails make records easier for buyers and auditors to interpret. **No user study was run.** The prototype provides the instrument (passport, public verification page, report) but no evidence of improved interpretation.
- Results on a real multi-organization network would show the same integrity outcomes with much higher latency.

**Future work:**

- A user study with buyers and repairers.
- Per-party key custody (wallets or HSMs) instead of server-held demo keys.
- A permissioned multi-node network with measured consensus latency.
- Signed centralized logs (Certificate-Transparency-style) as a further baseline.
- Integration with UNTP-style verifiable credentials.
- Field validation with real (consented) repair data.

## 7. When is blockchain appropriate here?

**Appropriate:** several *independent* organizations (repairers, refurbishers, resellers, auditors) need one shared, tamper-evident history, and none of them should control it alone. Each party signs with its own key, so no operator can forge another party's claim or resolve a dispute in an auditor's name. The benchmark's S7 and S8 show exactly this gap in the centralized stores.

**A centralized database is preferable when:**

- one trusted organization owns the process (for example a single OEM refurbishment line),
- latency and cost matter more than multi-party trust,
- rewrites only need to be detectable rather than prevented. Externally checkpointed hash chains do this well, as S1–S3 show.
- regulators or participants already trust a custodian.

## Limitations of this review

- Only the four supplied sources were checked. Each was verified for DOI, authors, venue, volume, pages and date, and for claims stated in its abstract. **No systematic search was performed.** Relevant work on blockchain e-waste tracking, right-to-repair data, transparency logs and EU DPP regulation is not covered.
- Full texts of refs 1–3 were not read. Statements about what they do *not* cover rest on abstracts only.
- UNTP is a draft specification whose versions differ. The page at the supplied URL did not render without JavaScript, so its content was read from the official mirror and search summaries.
- No institutional partnership, user study, field data, security audit or regulatory assessment exists for this project.
