# Correctness, data integrity and architecture review

Date: 2026-11-11. Starting revision: `5882213b21fd7047f014596ef04ba027aa6f0ff6`.
Perspective: business-flow correctness, cross-module contracts, concurrent updates and honest outcomes.
All reproduction used synthetic fixtures, injected provider responses and isolated PGlite. No production data, credentials or provider mutations were used.

## Confirmed findings and fixes

### C1 — P2: Life-admin reminders linked to a nonexistent page

Before this review, `src/server/life-admin/reminders-job.ts:60` generated `/life-admin/records/<id>`, but the application only has the `/life-admin` page. Each notification therefore pointed to a 404.

The job now generates `/life-admin?view=life&tab=<subscriptions|receipts|renewals>#record-<uuid>`, matching the existing page tab contract. Regression tests cover every record kind. The coordinating agent owns the corresponding record anchors, tab-preserving forms and notification transport/service-worker changes.

Related confirmed integration failure: `src/server/notify/production.ts` originally discarded `OutgoingMessage.link` when it called the subscription-only `send` seam; `web-push.ts` emitted an empty generic notification payload. This was reported to the coordinating agent for repair, so fixing only the job URL would not have been enough.

### C2 — P2: A stale reminder completion suppressed the next due-date cycle

`runLifeAdminReminders` reads due metadata, awaits a push, then updates `sent_offsets`. The old completion write matched only record ID and offset. If the person rescheduled the record while delivery was in flight, `updateRecord` correctly cleared the old markers, but the old delivery then appended its marker to the new date. The next cycle's reminder was silently skipped. Removing an offset during delivery also let completion reintroduce a marker for that removed setting.

Fix: `src/server/db/life-admin-records.ts:287` binds record ID, owner, captured due date and an offset that is still configured. Tests update the record inside the awaited push fake, verify the marker is absent, and advance the clock to prove the new cycle still sends. A separate owner/date test rejects mismatched completion writes. Arbitrary status text is preserved; status is not a lifecycle enum and must not invent an undocumented “active only” scheduling rule.

### C3 — P2: Duplicate configured offsets sent duplicate notifications

Offsets such as `[14, 14, 1]` were accepted and `unnest` returned the same reminder twice in one snapshot. The job sent twice even though each completion write itself was idempotent.

Fix: `listDueForReminder` (`src/server/db/life-admin-records.ts:257`) deduplicates the offsets in SQL, including existing stored rows. The regression first reproduced two pushes and now observes one.

### C4 — P1 availability / P2 validation: An overflowing offset broke the global reminder sweep

The prior portal/store accepted unbounded nonnegative integers. `DATE '2026-11-20' - 2147483647` raises `date out of range` in PGlite/Postgres semantics. Because the reminder query reads all people together, one such record could abort everyone's sweep. Values beyond int32 also failed at the database cast. ISO date syntax alone accepts year `0000`, while the database rejects `DATE '0000-01-01'`.

Fix: shared `src/domain/life-admin/record-metadata.ts` permits real ISO dates excluding year zero and at most 50 offsets of 0–36,500 days. The store validates metadata before queries; MCP and the coordinating agent's portal boundary share the date policy. The reminder SQL converts legacy out-of-range offsets to null before subtracting, so already-stored invalid metadata cannot stop valid reminders. Tests reproduce invalid date/offset rejection without any query and safely seed a legacy invalid offset to prove a valid reminder still sends.

### C5 — P2: Date omission and clearing had inconsistent semantics

The store interpreted an omitted `dueDate` as null, so a metadata/fields edit could erase scheduling. The MCP update tool instead used null-coalescing and could not explicitly clear a due date; its schema accepted arbitrary strings rather than calendar dates.

Fix: the database update uses a supplied-value flag: omission preserves the current date and markers atomically; explicit null clears the date and old markers; a changed date starts a fresh cycle. MCP accepts a validated nullable date and forwards omission unchanged. Focused store and MCP tests cover omitted, null, impossible dates, timestamp strings and year zero. Portal date inputs and parsing are coordinated separately by the root agent.

### C6 — P2: Activity reported successful Undo for refused, failed or pending reversals

`src/server/activity/undo.ts` always returned `ok: true` after `runReversal`, even when the plain-text outcome said the action failed or required approval. The activity action therefore selected the successful “undo done” notice. Existing tests explicitly expected success for a pipeline refusal, masking the product defect.

Fix: `UndoReversalResult` has explicit executed/refused/pending/failed statuses. The attempt is still recorded, but success is returned only for executed reversals. Calendar provider responses must also be 2xx; HTTP 404 and transport failures no longer become “Undone.” A pending reversal displays a waiting notice stating the action has not been undone and links to `/inbox` to review the approval. Provider failure and policy refusal have separate notices. Tests cover failure, approval pending, denial, the notice round-trip and actual success. Older misleading test expectations were corrected.

### C7 — P2: Calendar Undo had no target event ID

The production reversal call in `src/server/mcp/compose.ts` set only connector/tool/account; it supplied no `params`. The curated delete executor requires `query.eventId`. The audit captured create parameters but never the provider-created ID, making the advertised Undo impossible to execute correctly.

Fix: `src/server/activity/calendar-reversal.ts` extracts only a bounded opaque event ID from a successful Google/Microsoft calendar create response. The pipeline includes this minimal reversal reference in the existing encrypted, redacted audit payload for immediate and approved-held creates. Provider event bodies, attendees and descriptions are never copied. Undo validates the original successful Warthog entry, declared delete tool, target ID and original service account, then submits the reversal through current policy and account selection. It never guesses a target or switches accounts.

The activity page offers Undo only when valid metadata exists. Historical entries cannot recover a provider-generated ID that was never stored and remain unavailable for automatic Undo. A redacted/malformed/missing ID is likewise unavailable. Tests cover both providers' metadata, invalid/truncated responses, old/agent-authored/failed entries, the exact deletion URL, current denied/ask permissions, changed account, HTTP failure, transport failure and approved-create capture.

### C8 — P2: A superseded reset's alert failure cancelled a newer successful request

Independent review of the security changes found an adjacent race in `src/server/auth/account-reset.ts`: reset requests commit before sending alerts; if all sends fail, compensation cancelled any pending reset for that user and removed all pending reset timers. Request A could stall in notification delivery, request B could supersede it and successfully notify the person, and A's later failure would cancel B and delete B's timer.

The regression drives that exact interleaving with synthetic promise-controlled senders. It failed with the newer row marked `cancelled`. Compensation now matches the failed request's captured `requested_at`, returns the claimed row, and clears jobs only if that generation was actually cancelled. The transaction holds the row lock through cleanup, preserving a subsequent request and its timer. The test checks that the newer request remains pending, its exact seven-day timer survives, and the older deadline still cannot erase data.

## Independent security-change review

Reviewed the security agent's reset deadline, recovery generation, OAuth token-store/rotation changes, additive migration and targeted tests. Apart from C8 above, no blocking correctness defect was established: the reset wait is checked in the same atomic claim as completion; passkey registration rechecks the recovery generation under a row lock and commits the factor/code together; refresh-client matching happens under the connection lock before mutation or replay revocation; the retry successor preserves the same binding. Historical unbound refresh tokens deliberately require reauthorization, while existing access tokens keep their expiry. The security agent owns separate PostgreSQL concurrency verification and the root owns release compatibility/integration.

Checked the calendar identifier policy against primary provider references. The bounded validator accepts Google's documented base32hex alphabet and 1,024-character maximum, as well as Microsoft's case-sensitive padded identifiers. Both existing curated resolvers use `encodeURIComponent`, so accepted slash/plus/padding characters remain encoded within the resource path segment. [Google event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events), [Microsoft create-event example](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0).

Microsoft's default event IDs may change when the item moves to another calendar/container. This implementation retains the existing ID semantics and safely reports an unavailable/failed reversal instead of guessing another target; adopting immutable IDs consistently is a separate connector change. [Microsoft event ID semantics](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0).

## Concurrency and delivery limits retained deliberately

- Reminder delivery is at least once across failure ambiguity: a process can deliver to the provider and crash before recording completion. The external send and database write are not one atomic transaction. Documentation no longer claims exactly once.
- `src/server/jobs/scheduler.ts:63` claims a sweep interval atomically, and `:100` prevents overlap inside one scheduler instance. A different process can claim the next interval while an unusually long prior sweep is still running. The changes above do not introduce a durable per-reminder delivery lease or provider idempotency contract. Overlapping long sweeps can still repeat delivery; preventing that needs a coordinated scheduling/outbox change and cannot eliminate provider-acknowledgement ambiguity by itself.
- The stale completion guard identifies a cycle by owner and due date. A rapid A→B→A edit while one delivery is in flight is not a distinct versioned cycle. Normal reschedules and removed offsets are guarded; a future cycle token would be needed for stronger ABA semantics.
- Approved held calls intentionally claim execution before an external action. A crash after the claim can leave an in-progress result with uncertain provider outcome. Automatic retry would risk duplicate external changes; this review did not replace that safety tradeoff with an unproven exactly-once claim.

## Review breadth and limits

Read the repository instructions, technical-design brief, agent-first management ADR, resource-audience policy and collection-bound conventions. Traced these areas beyond the confirmed bugs:

- MCP discovery/context versus current per-agent permissions; connector inventory versus selected accounts; global rule precedence and high-tier/card release separation.
- Approval creation, held-call claim/outcome handling, disconnected-agent checks and re-evaluation of current deny rules.
- Resource audiences for skills and memory, package revision updates/projections, ownership checks, import transactions and disabled imported packages.
- Task claims, note updates, assignee checks and row-lock use; concurrent completion and claim expiry semantics.
- Household release locking, reference-rate/period unavailability, member/household budget checks, ledger reads and SMS quota transactions.
- Connector account selection, credential-refresh locking, curated execution routing and disconnect cleanup.
- Scheduler interval claims and leased job attempt/completion guards.

No additional reproducible correctness defect was established in those areas during this pass. This is a risk-based review, not proof that every source line or provider integration is bug-free. The security specialist owns auth/crypto/SSRF and the UX specialist owns mobile/desktop interaction review. Real provider compatibility, large-account load, multi-process scheduling and production deployment verification remain separate validation dimensions.

## Validation record

- First reminder-link/reschedule/removed-offset regressions: 3/3 failed against the original behavior, then passed after the fixes.
- Duplicate-offset regression: observed 2 pushes before the fix, 1 after it.
- Undo false-success and missing-target regressions: reproduced before changes.
- Omitted-date and metadata validation regressions: reproduced before changes.
- Initial focused reminder/store run: 51 tests passed; owner/date guard test passed separately.
- New cross-module regression subset: 9 tests passed.
- Expanded focused run: **183 tests passed, zero failures** across 11 files: calendar reversal metadata, Undo service, MCP composition, immediate and approved-held pipelines, MCP records, reminder job, record store, activity actions, activity page and activity notices. Node v22.23.2 with `node --import tsx --test`; output retained locally at `/tmp/warthog-correctness-targeted-tests.log`.
- Subsequent pending/failure-notice follow-up: four focused cross-module tests passed; all three calendar metadata validation tests passed after allowing encoded base64-style opaque identifiers.
- Independent security review and reset compensation fix: **66 tests passed** across reset deadline/request, recovery primitive/handler and OAuth client-binding suites. The new superseded-alert regression failed before the compensation guard and passed afterward; local output is `/tmp/warthog-correctness-security-review.log`.
- `git diff --check` passed. Full-suite/type/build/deployment checks remain coordinated by the root agent.
- Reviewed the coordinating agent's shared notification parser, production push adapter, encrypted Web Push payload and service-worker routing against the reminder job's exact tab/UUID link contract; no compatibility defect found. Portal and store use the same metadata schemas.
