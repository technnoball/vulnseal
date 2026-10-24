# Research gap — VulnSeal

**Full title:** *VulnSeal: Privacy-Preserving Cross-Platform Bug Bounty Priority and Dispute Arbitration Using Blockchain Commitments*

This is a **preliminary** related-work assessment, done on 24 October 2026. It is not a systematic literature review. See [Search method and limitations](#search-method-and-limitations).

## 1. Problem

Bug bounty and vulnerability disclosure programs run separate submission systems. Each has its own internal timestamps, review rules and confidentiality requirements. Suppose two programs (for example, the vendor of a shared component and a vendor that embeds it) receive overlapping reports. Neither program, and none of the researchers, has a **mutually trusted record** that shows:

- which report content existed at which point;
- that the content later revealed is the content originally submitted;
- who decided that two reports concern the same issue;
- how a disagreement about priority was argued, decided and appealed.

Each platform's internal log is controlled by its operator.

## 2. Related work (metadata verified)

| # | Source | What it establishes | How VulnSeal relates |
|---|--------|---------------------|----------------------|
| 1 | HackerOne Help Center, *Duplicate Reports*, page dated 24 Apr 2026. https://docs.hackerone.com/en/articles/8514410-duplicate-reports | The **program** marks a report as a duplicate of an earlier report. The duplicate reporter then either (a) sees limited metadata of the original (title, state, submission date, severity), or (b) is added as a participant with full access. The page does not describe how duplicates are judged, timing rules, or cross-program cases. | Duplicate handling **within one platform and one program** is established practice, decided by the program. VulnSeal keeps the program's authority over that judgement. It adds only a shared, verifiable record of commitments, reveals and decisions across programs. |
| 2 | Bugcrowd Docs, *Assigning Submission Statuses* (no date shown; © 2026). https://docs.bugcrowd.com/customers/submission-management/submission-status/ | Statuses are New, Triaged, Unresolved, Resolved, Informational, Out of Scope, Not Reproducible, Not Applicable and Duplicate. The **customer** marks a duplicate, which must point to an original (inside the program or a "Known Issue" tracked elsewhere) and inherits the original's state. A report cannot be marked duplicate of an already-Resolved issue that still reproduces. | Platforms define **policy-dependent** status and duplicate rules. VulnSeal's status machine is modelled loosely on this. Eligibility and reward rules stay with each program's policy, which VulnSeal references only by digest. |
| 3 | FIRST Vulnerability Coordination SIG, *Guidelines and Practices for Multi-Party Vulnerability Coordination and Disclosure*, v1.1 (May 2020; v1.0 2017). https://www.first.org/global/sigs/vulnerability-coordination/multiparty/ | Bilateral (one researcher, one vendor) practices "do not adequately scale" to open source, bug bounties and supply chains. The document derives multi-party guidelines from coordination scenarios. The landing page does not cover priority disputes or cryptographic commitments, and I did not read the full guidelines. | **Multi-party coordinated disclosure is an established field.** VulnSeal does not claim to invent it. It targets one narrow artefact inside such coordination: verifiable priority and adjudication records. |
| 4 | CERT/CC, *Vultron* repository. https://github.com/CERTCC/Vultron | A research prototype ("not ready for production use"; MIT licence) for a **federated, decentralized CVD protocol**. It covers process models, a formal protocol, behaviour logic, a minimal case and participant state model, and a mapping to ActivityPub/ActivityStreams. Its README does not mention blockchain or cryptographic commitments. | **Decentralized, federated coordination already exists in research.** Vultron federates *messages and case state* between parties' own trackers. VulnSeal instead anchors *commitments and adjudication events* on a shared ledger. The two could be complementary. |
| 5 | CERT/CC, *Vultron protocol documentation*. https://certcc.github.io/Vultron/ | The problem it addresses: cross-organization CVD currently needs accounts on each partner's system, or falls back to encrypted email. Vultron lets existing trackers exchange structured messages, like SMTP or XMPP. It is an early, unreleased development build. | Same as above. VulnSeal does not replace case messaging. |
| 6 | Liu, S., Zhou, J., Hu, X., Cogo, F. R., Xia, X., & Yang, X. (2025). An empirical study on vulnerability disclosure management of open source software systems. *ACM Transactions on Software Engineering and Methodology*, article 3716822 (online 24 Mar 2025). https://doi.org/10.1145/3716822 | Analyses the disclosure practices of 8,073 OSS projects (2017–2023) plus a practitioner survey. Over 80% of practitioners support CVD, but only 55% of vulnerabilities conform to it in practice. 42% are discussed in issue reports before disclosure. | Empirical motivation: confidentiality before disclosure is often **not** maintained. Recording report *content* openly would be harmful, which supports keeping only commitments on the shared ledger. |
| 7 | Zhu, K., Yang, W., Pan, M., & Zhou, Y. (2026). Detecting duplicate vulnerability records across databases. *Science of Computer Programming*, 247, 103357 (January 2026). https://doi.org/10.1016/j.scico.2025.103357 | Per its title, it addresses **duplicate vulnerability records across different vulnerability databases**. Metadata was verified via Crossref and Semantic Scholar. **I could not access the abstract or full text**, so I do not describe its method or results here. | Cross-database duplicate *detection* is an active research topic. VulnSeal does **not** detect duplicates automatically: humans propose associations, and the counterpart program reviews them. A detector such as this could feed proposals into VulnSeal's review workflow. |

## 3. What VulnSeal does not claim

- It does not invent coordinated or multi-party vulnerability disclosure (FIRST, Vultron).
- It does not invent duplicate handling (HackerOne, Bugcrowd) or duplicate detection (Zhu et al.).
- Blockchain timestamps, append-only logs and hash commitments are long-established techniques.
- It does not prove discovery priority in the real world.

## 4. Candidate contribution (narrow)

The research question is whether a **privacy-aware, blockchain-anchored commitment and arbitration protocol** improves the verifiability of report priority and dispute histories across independent bug bounty programs. It should do this:

- without publishing confidential vulnerability details;
- without requiring complete trust in one central operator.

The candidate contribution is the **combination** of the following, implemented and measured in one prototype:

1. Versioned, domain-separated commitments to structured reports: field hashes, an evidence root and a 256-bit secret nonce, bound to researcher, program, policy version, chain and contract.
2. Confidential off-chain storage (AES-256-GCM), with explicit reveal verification and a five-way outcome: match, mismatch, missing material, invalid encoding, not yet revealed.
3. Cross-program association that a human proposes and the **other** program reviews. A pseudonymous issue-family token is assigned only after confirmation.
4. Append-only dispute arbitration enforced by a smart contract:
   - 2-of-N arbitrator threshold;
   - recusal of conflicted arbitrators, enforced on-chain;
   - an appeal heard by a fresh panel;
   - reason codes and policy-digest references.
5. A hash-chained on-chain event log, with off-chain/on-chain consistency checking.
6. A measured comparison with an editable centralized store and a hardened (signed, hash-linked, optionally checkpointed) centralized log.

**Whether this combination is new is not established.** The assessment covered only the seven sources above. I found no source among them that combines commitments, cross-program arbitration and a blockchain anchor. That is a limited observation, not a finding of novelty.

## 5. Research questions

- **RQ1.** Can the system detect post-submission alteration of a report when its revealed contents are checked against a previously recorded cryptographic commitment?
- **RQ2.** Can cross-program claim association and dispute histories be made independently auditable without exposing complete vulnerability reports on-chain?
- **RQ3.** What privacy, performance, storage and operational trade-offs arise compared with a conventional centralized database and an append-only centralized audit log?
- **RQ4.** Which important trust problems remain unsolved by blockchain, including false reports, unreliable source timestamps, dishonest adjudication and identity abuse?

The evaluation design and the measured answers are in [experiment-protocol.md](experiment-protocol.md) and [results/](results/README.md). RQ4 is answered analytically in [threat-model.md](threat-model.md).

## 6. When a shared ledger helps, and when it does not

**It helps when** several organizations that do not fully trust one another need the same record of who committed what and when, who decided what, and which arbitrators were allowed to decide. No single operator should be able to:

- rewrite that record;
- backdate an entry;
- sign a decision in an arbitrator's name.

**A conventional database is preferable when:**

- one platform runs the whole process, which is the normal case today;
- participants already trust a neutral operator or a timestamping authority (RFC 3161);
- metadata linkage (who submitted to which program, and when) must not be visible to other consortium members;
- operational simplicity matters more than independent verifiability.

The benchmark measures these trade-offs.

## Search method and limitations

- **Sources:** the seven sources named in the project brief. Each was opened and its metadata checked:
  - DOIs via the Crossref API (and Semantic Scholar for Zhu et al.);
  - web pages fetched directly on 24 Oct 2026.
- **Supplementary search:** one web search ("Detecting duplicate vulnerability records across databases" with the author names), done only to locate an abstract, without success.
- **No systematic search** (databases, inclusion criteria, snowballing) was performed. The following are **not covered**:
  - blockchain-based CVD or bug-bounty proposals;
  - RFC 3161 and transparency-log literature;
  - private set intersection and privacy-preserving matching;
  - commit-reveal schemes in other domains.
- **Not read in full:**
  - Liu et al. and the FIRST guidelines: assessed from abstracts and landing pages only;
  - Zhu et al.: assessed from metadata only.
- Platform documentation changes over time. The descriptions above reflect the pages as fetched on the date stated.
