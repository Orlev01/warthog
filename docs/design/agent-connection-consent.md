# Agent connection and consent

The consent page is a focused task outside the workspace shell. It must still
use the same typography, neutral tokens, bounded widths, touch targets and
navigation affordances. Access-key setup uses the same permission editor and
copy so the two ways of connecting an agent cannot drift.

## One flow, three sections

1. **Confirm the connection:** show the callback host, including a non-default
   port; explain what the verified-platform badge establishes; name the agent.
2. **Choose its access:** compare Minimal, Standard and Custom in concrete terms,
   with an editor grouped into everyday information, memory, tasks/records,
   sensitive requests and connected services.
3. **Review:** show the actual selected capabilities, selected services, sensitive
   request settings, sharing and card-release budget before approval.

Keep the entire form mounted. Optional examples use native, named disclosures;
the explanation needed to make a decision stays visible beside its checkbox.
Custom opens the editor and preserves the current choices. Editing a checkbox or
budget selects Custom. Selecting Minimal or Standard deliberately restores that
preset, with visible copy explaining this replacement. A newly loaded Custom
template still starts with Standard's domain defaults.

## Permission and trust language

Shared copy and form-state mapping live in
`src/domain/permissions/connection-choices.ts`. Template grants remain in
`templates.ts`. Always submit explicit on/off choices; never let a starting
template silently restore an unchecked capability.

- Memory reading and saving are independent, matching the existing server model.
- Tasks and life-admin records include changes, not only viewing.
- Services require an explicit selection. Reads are allowed; changes ask first.
  Multiple accounts still require selection in the agent workspace before use. (Superseded 24 Nov 2026: the screen lists each account as its own checkbox, and an agent can be given several accounts of a service; see ../adr/several-accounts-per-agent.md.)
- Protected identity and cards permit requests; each release still needs approval.
  A card budget limits approved releases, not purchases or bank charges outside
  Warthog.
- Sharing applies to new memories, subject to their audience. It does not rewrite
  existing memories or grant access to other agents' private notes.
- Preferences, assigned/enabled skills and activity logging are explained as
  connection behavior, not presented as disabled permission switches.
- A recognised callback does not verify an agent's behavior or request safety.
  Global rules remain enforced. Warthog's controls cover requests through Warthog.

Approval creates a distinct connection. Explain the return to the platform, where
permissions can be changed, and what disconnecting stops. Information already
received cannot be recalled. Refusal creates no connection.

## Submission and recovery

Consent uses event-driven submission inside a React transition. A synchronous
guard prevents duplicate approval/refusal, FormData is captured before controls
freeze, and the initiating button keeps focus. This also avoids React's automatic
form reset when a server action returns a handled validation error (see
[React form behavior](https://react.dev/reference/react-dom/components/form) and
[Next server-function event handlers](https://nextjs.org/docs/app/getting-started/mutating-data)). Keep the
entered name, permissions, services and budget consistent with the review.

The server continues to resolve the session and pending request from host-locked
cookies, validate all input, enforce ownership, consume one-time requests and
issue credentials transactionally. Client state is never authority. Refusal
bypasses name/budget validation. Controls become available after hydration; the
consent page explains the JavaScript requirement when scripts are unavailable.

Expired or already-used requests need a titled state, restart instructions and
links to Agents and the connection guide. Do not imply that an existing approved
connection has been removed or that opening the page creates a new request.

## Verification

Check both connection methods, all presets, changed permissions, independent
memory read/write, budgets, service selection, duplicate submission, server
rejection, refusal and redirect completion. Verify the stored grants as well as
the submitted form. Inspect unknown/long callback addresses, empty services and
expired requests on phone, desktop, both themes and actual safe-area emulation.
