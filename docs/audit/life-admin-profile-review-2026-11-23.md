# Warthog review and the life-admin profile — 23 November 2026

## How the review was done

The review was read-only, run against `main` at `1aaa546`. Six reviewers worked in parallel, each
from one perspective:
- engineering;
- product and UX;
- the life-admin taxonomy;
- the architecture for filling records in;
- privacy, security and trust;
- how agents read records.

Each finding below was checked against the code, and the high ones were re-verified by hand. The
feature built from this review is described in [the ADR](../adr/life-admin-profile.md).

## Overall health

**Sound foundations, with a few serious gaps.** The following all hold up under review:
- member scoping (no query was found missing its `user_id`);
- SSRF protection (the address checked is the one pinned, and redirects are refused);
- field encryption (a versioned envelope bound to table, column and row);
- held calls running exactly once;
- the serialised activity hash chain;
- read-side protection;
- admin portal isolation.

The bug-bash fixes from 11 November hold.

**Life admin was the least mature area.** It was:
- free-form blobs in three hard-coded kinds;
- no provenance, de-duplication or review;
- a form that couldn't capture the brief's own fields;
- reminders that misfired.

## Findings outside life admin

| Sev | Finding | Where | Fix |
|---|---|---|---|
| **High** (fixed 23 Nov, PR #45, released as `warthog--r45118618704a1`) | **OAuth consent swap.** Approve applies to whichever pending request the `__Host-wh_consent` cookie names when it is submitted, not to the request the person was looking at. An attacker page can show Claude's real consent in a popup, then load its own `/oauth/authorize` at the top level, which overwrites the cookie. The victim's Approve then issues a code to the attacker's DCR client. Approve also needs no step-up. | `src/app/oauth/authorize/handler.ts:108-114`, `src/app/oauth/consent/page.tsx:97-105`, `src/components/agents/consent-view.tsx` | Carry the pending handle (or an HMAC of it) in the form and require it to match the cookie. Require step-up on Approve. |
| High (fixed 23 Nov, `claude/security-highs`) | **Expensive work happens before rate limiting.** Every MCP request, `tools/list` included, unwraps the DEK through Key Vault before `rateLimiter.allow`, and unwraps aren't cached. A looping agent can exhaust the shared Key Vault quota for everyone. | `compose.ts:559`, `pipeline.ts:529-550`, `crypto/key-wrapper.ts:87-97` | Rate-limit in `dispatch` before `buildServer`, and add a short DEK cache (the design allows 5 minutes). |
| High (fixed 23 Nov, `claude/security-highs`) | **Email addresses outlive account deletion.** The email-code tables and household invites keep plaintext addresses that the purge never touches. | `auth/email-code.ts`, `account/purge-job.ts:73-87` | Delete these rows by address in `purgeAccount`, and add a TTL sweep. |
| Medium | **Per-account storage is unbounded.** Imports can reach 100k parts of 12 MiB; tasks, rules and receipts have no caps; Postgres auto-grow is off. | `import/parts.ts`, `infra/main.tf:130` | Add caps and auto-grow or a disk alert. Records are now capped (see the fixes below). |
| Medium | **"Never allow" domain rules can silently match nothing**, for example `@rival.com` or a subdomain. | `domain/rules/rules.ts:235-240` | Normalise the domain when the rule is created, and match subdomains. |
| Medium | **A slow sweep delays approval expiry and fallbacks**, because sweeps run one after another. | `jobs/scheduler.ts:98-135` | Run approval expiry in its own loop, and give each sweep a time budget. |
| Medium | **Anyone can block new connections without signing in.** DCR has a global cap of 100 an hour, and `/oauth/authorize` isn't rate-limited. | `oauth/register/handler.ts:36`, `oauth/clients.ts:51` | Limit per IP, and pin the known platforms' client documents. |
| Medium (UX) | **First run ends with "my agent can't read my email".** The checklist asks to connect an agent before a service, and connecting Gmail never asks which agents may use it. | `domain/home/checklist.ts:37-41`, `connectors/notices.ts:15` | Reorder the checklist, and offer "turn it on for your agents" after an OAuth connect. |
| Medium (UX) | **Identity is split across Vault, Skills › Preferences, Memory and Life admin.** Time zone and language each live in two places. | `identity-view.tsx`, `skills-view.tsx` | Settle on one place for each. |
| Low | `drive__metadata` / `onedrive__read` query passthrough; `..` as an id; receipt blobs encrypted without associated data; secrets inside `__request` JSON strings not redacted; dead `createImportHandler`. | see the engineering report | Small fixes, each on its own. |

## Life-admin findings, and what this branch does about them

| Finding | Status |
|---|---|
| An agent's `update_record` silently overwrote records the person entered, and they still read as the person's | **Fixed.** An agent's change to a confirmed record waits as a pending change, and `changed_by` is recorded. |
| `list_records` returned every record in full, unpaged and unlabelled, with raw agent ids and no savedBy | **Fixed.** It now has filters, a cursor, type and field labels, `savedBy`, `checkedByPerson`, provenance and monthly totals. |
| No field schema; agents invented keys | **Fixed.** A typed catalogue, alias folding and a generated skill. |
| No de-duplication; the brief's own journey duplicates subscriptions on a second run | **Fixed.** The HMAC match key updates the existing record, and a dismissed record leaves a tombstone. |
| Records were a channel for prompt injection | **Mitigated.** Agent records are suggestions; links are cut to site names; payment references are refused; provenance is checked against the read window; house-skill guidance was added. |
| TFNs, passwords and government IDs could be saved and would land in activity | **Fixed.** They are refused in the input schema, so the value never reaches activity. |
| Reminders fired for cancelled or done records, fired in bursts on old dates, and failed every hour for people without a push device | **Fixed.** Status-aware, with a 7-day grace, one push per person per sweep, and `NoPushDeviceError` handled. |
| Edits turned agent-saved objects into "[object Object]" | **Fixed in the UI pass.** Edits merge and leave non-scalar values untouched. |
| The person couldn't enter typed details; the page never showed who added a record | **Fixed in the UI pass.** Typed add and edit forms, and a provenance line. |
| Records had no per-person cap | **Fixed.** 2,000 records and 20 MB. |
| The moving checklist ignored most address-holding records | **Fixed.** Rego, licence, insurers, utilities, super and so on now seed it. |
| Export dropped `sentOffsets`; import accepted a bad kind as a 500 | **Fixed.** Export carries type, review state, links and provenance; import refuses an unknown kind or type with a 400 and drops forbidden fields. |
| One date per record; no recurrence; no email fallback for reminders; no per-category grants; record values in activity | **Open.** These are listed as follow-ups in the ADR. |

## Why the person's own agent fills it in (Option B)

Three ratified constraints each rule out Warthog running a model:
- `no-ai-model-calls`;
- `zero-cost-third-parties`;
- `azure-australia-east`.

Option B is also the simpler one to build, and the better one for the future:
- it costs Warthog nothing;
- the privacy story is unchanged;
- it improves as agents improve;
- it works in any client with tools.

MCP sampling is deprecated in the 2026-07-28 spec, and claude.ai and ChatGPT don't support it.
For the full comparison, see the ADR.

## Decisions for the founder

1. **Number plates are everyday details in Vehicles records.** The brief has been amended
   accordingly. The alternative is to keep plates only in the Vault, which would mean an approval
   every time an agent needs the plate.
2. **Records agents saved before this change now show as "Not checked yet".** This is the honest
   reading, but existing users will see a review list the first time.
3. **Health and money records are visible to every agent with records access.** A per-category
   grant is a follow-up.
4. **The OAuth consent swap is fixed and released** (PR #45, `warthog--r45118618704a1`). The consent
   form carries a tag of the request it shows, and Approve or Deny acts only while the cookie
   still names that request. Approving also asks the person to confirm it's them, as making an
   access key does.
