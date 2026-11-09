# Coordinating review: policy, persistence and integration

9 November 2026. Read with the master register and specialist reports. Evidence
refers to the working tree, not a committed release or deployed service.

## Confirmed defects corrected

| Finding | Trigger and impact | Correction and evidence |
| --- | --- | --- |
| AUD-008 | An agent spends USD 60, then its budget changes to AUD. Raw ledger SUM reports 60 instead of the converted 90, permitting overspend. | `spending/agent-spending.ts` groups by currency, converts each subtotal and propagates missing-rate state to policy and locked release. Real store/policy/release regressions first failed; 89 affected checks passed, then 45 after grouped-query refinement. |
| AUD-009 | Home uses the account currency rather than the agent budget currency, and its component hardcodes A$. Missing historical rates can appear as a complete lower total. | Carry actual budget currency to the view and show unavailable totals explicitly in Home/Spending. Three render regressions first failed; 39 affected checks passed. |
| AUD-010 | Distinct public CIMD URLs retain metadata without a capacity bound; initial DNS can occupy an in-flight slot indefinitely. | Cap 128 LRU entries, 24-hour TTL, 2048-character URLs, 16 concurrent resolutions, 64 KiB bodies and a five-second DNS-through-body deadline. Cancel rejected bodies. Security peer review found the DNS gap; final 49 focused checks pass. Underlying DNS cancellation depends on the resolver, but late results cannot keep a waiting slot open. |
| AUD-012 | Sydney and Los Angeles members record/read different household months for the same instant. Each can see only part of shared spending. | Migration 0098 and production release writes use a shared UTC month. Personal periods are unchanged. Only matching owned approval release timestamps backfill history; unknown historical instants remain incomplete and capped requests fail closed. Two failing regressions and a render regression reproduced the gaps; 92 focused checks passed. Additional context assertions now preserve personal November versus household December UTC explicitly. |
| AUD-023 | `amount_over` compares original foreign numbers despite the domain contract requiring conversion. Agent budget currency can also differ from the owner's rule currency. | Separate rule-currency/rate context, normalize before applicable condition matching and refuse missing rates. Rules screen names its account currency. Three failing regressions; 95 policy/context/pipeline/page checks passed. |

Each structural choice has an ADR. The household data migration deliberately does
not invent timestamps or rewrite personal accounting history. Exchange-rate
totals remain daily-reference estimates, not settlement amounts or a payment
processor's guarantee.

## Architecture and code-practice observations

The existing separation of pure domain rules, injected server dependencies,
member-scoped stores, composition roots and thin page handlers is useful. Repairs
reuse those boundaries rather than introducing a new framework. Parameterized
queries, encrypted personal payloads and explicit ownership checks are widespread;
the security review specifically followed their exceptional paths and races.

The main design weaknesses were cross-layer contracts: advertised UI paths that
were not connected, mismatched monetary units, transaction boundaries split across
multiple writes, and deployment documentation that described infrastructure not
present in source. Regression tests now exercise those boundaries. Native PGlite
transactions exposed accidental outer-handle reads; those callers were corrected
instead of preserving a misleading test adapter.

Background work has durable claims, bounded drains, retry/dead-letter handling
and a singleton scheduler. Messaging adds durable outbound reservations and
one-attempt handling for ambiguous SMS sends. These controls do not turn provider
acceptance into delivery, or budgets into a currency spending stop. A single
process and deliberate stop/wait/start rollout remain architectural requirements.

The repository carries extensive historical task comments and test-contract
prose. Some comments were stale and were corrected where behavior changed.
Broad cosmetic rewrites would obscure this already large release change; future
cleanup should replace redundant historical narration with current contracts in
small, separately reviewed patches. TypeScript and the existing validation seams
remain the appropriate language/boundary design; no new runtime dependency is
needed for these fixes.

## Limits requiring later evidence

Real PostgreSQL contention/least-privilege bootstrap, clean Linux installation,
container startup, provider-schema validation, remote CI and an immutable image
remain separate from local PGlite/Node checks. Browser layout, keyboard/focus,
passkey hardware and real delivery/connector acceptance need actual environments.
Provider prices, entitlements, registrations and budget protection are not resolved
by this audit. The final integrated verification result belongs in `README.md`;
the focused counts above are evidence for individual fixes, not additive totals.

## Integration follow-up

The first integrated run exposed three release-race fixtures intercepting obsolete
raw BEGIN calls. They now intercept the transaction seam, assert that the mutation
actually occurred and retain refusal/no-release/no-ledger assertions. The month-end
fixture now crosses UTC midnight and explicitly seeds its canonical household month.
All 44 release-handler checks pass. A quoted Node test path containing `[id]` must
use a matching wildcard; a zero-test invocation is not verification.

The same run exposed AUD-025: an activity append could hold a JavaScript queue
while waiting for a database transaction whose callback waited for that queue.
The security reviewer replaced the queue with one transaction-scoped database lock
and explicit transaction-handle markers, with commit and rollback regressions.
Coordinator peer review checked handle reuse, nested-transaction refusal, member
scoping and account/foreign-key lock ordering. Real PostgreSQL contention is
prepared but still requires the isolated Linux harness.
