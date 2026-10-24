// Fictional disclosure policies. Their keccak256 digests are registered on-chain; the
// text lives off-chain. Programs and policies are invented for the demonstration.
export const POLICY_TEXTS: Record<number, string[]> = {
  1: [
    `Ashgrove Payments - Vulnerability Reward Policy v1 (FICTIONAL)
Scope: checkout.ashgrove.example, merchants.ashgrove.example.
Priority: the earliest commitment whose reveal matches and that is reproducible wins. Later reports of the same issue are duplicates.
Duplicates across programs: decided jointly with the other program; unresolved cases go to consortium arbitration.
Disclosure: no public disclosure before a fix or 90 days.`,
  ],
  2: [
    `Kestrel Cloud - Security Disclosure Policy v1 (FICTIONAL)
Scope: console.kestrel.example, storage API.
Priority: first actionable report wins; an earlier report that lacked reproduction steps when committed can lose priority (reason 110).
Duplicates across programs: accepted only when the root cause and fix are shared (reason 120).
Disclosure: coordinated; 90 days.`,
  ],
  3: [
    `Tamarind Mobile - Bug Bounty Rules v1 (FICTIONAL)
Scope: Tamarind iOS and Android apps, api.tamarind.example.
Priority: earliest matching commitment, if reproducible on a supported app version.
Disclosure: coordinated; 120 days.`,
    `Tamarind Mobile - Bug Bounty Rules v2 (FICTIONAL)
Scope: Tamarind iOS and Android apps, api.tamarind.example, partner SDK.
Priority: earliest matching commitment, if reproducible on a supported app version. Shared-library issues follow the consortium relationship decision.
Disclosure: coordinated; 120 days.`,
  ],
};
