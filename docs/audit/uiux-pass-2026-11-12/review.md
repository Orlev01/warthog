# Whole-app UI/UX pass — 12 November 2026

The founder asked for a complete UI/UX pass across the whole application: bugginess, layout
across devices, responsiveness, spacing, design and content, with one firm rule: no free text
on the background, only inside a compartment or component. The rule is recorded as
[contained text](../../adr/contained-text.md).

## Method

1. A synthetic member (populated with two agents, one with a long name, plus long and unbroken
   memories, tasks, records and activity) was signed up on a local dev server with a virtual
   passkey. [`capture.mjs`](capture.mjs) captured 66 screens (every route, agent section and
   in-page tab or filter state) at 320, 390, 768, 1024, 1440 and 1920px, in 844×390 landscape, and
   in dark mode at 390 and 1440: 594 captures. Each capture records the free-text check described
   in the ADR, horizontal overflow, off-screen elements, clipped text, touch targets under 44px
   below 1024px, form fields under 16px, approximate contrast, unnamed controls and console errors.
2. Nine auditors reviewed the app through separate lenses: containment, mobile and touch,
   desktop and wide screens, design system and spacing, content, interaction QA, public and
   account-entry flows, accessibility (WCAG 2.2 AA, axe-core plus scripted keyboard, zoom, forced
   colours and text-spacing checks) and the first-time member. They found 270 issues: 1 blocker,
   101 major, 132 minor and 36 polish.
3. Fixes landed in two phases with strict file ownership: shared layout surfaces, shared
   controls and the public and entry screens first; then Home and Inbox, Activity, Agents and
   dev pages, Connectors/Vault/Skills/Memory, Life admin/Spending/Rules/Household, and Settings.

## Result

| Measure, across all 594 captures | Before | After |
| --- | --- | --- |
| Text whose nearest container is the canvas | 17,166 (61 of 66 screens) | 0 |
| Touch targets under 44px below 1024px | 741 | 0 |
| Form fields under 16px below 1024px | 497 | 0 |
| Horizontal document overflow | 1 | 0 |
| Off-screen elements | 2 | 0 |
| Console errors, failed captures | 0, 0 | 0, 0 |

Visible clipped text and visible low-contrast text are both zero. The remaining detector hits
are screen-reader-only labels, re-checked by excluding visually hidden elements. Full numbers
are in [layout-results.json](layout-results.json). Before and after screenshots:
[Home](before-light-1440-home.jpg) → [after](after-light-1440-home.jpg),
[Activity on a phone](before-light-390-activity.jpg) → [after](after-light-390-activity.jpg),
[agent overview, dark](before-dark-1440-agents_ID__section-overview.jpg) →
[after](after-dark-1440-agents_ID__section-overview.jpg),
[landing on a phone](before-light-390-landing.jpg) → [after](after-light-390-landing.jpg).

Highlights beyond containment:
- **Shared surfaces and controls:**
  - a heading band, panels with action bars, list groups, one list toolbar, a page notice slot
    and empty states with a next step;
  - aligned shell edges, with one width per section family;
  - a short-screen sidebar and a sticky phone header;
  - tab tracks that keep the active tab in view;
  - not-found and error screens that keep the workspace shell.
- **Forms:** forms block repeat submits and keep keyboard focus; destructive actions use a
  danger style and confirm first, including passkey removal, Close household, Remove member and
  record deletion.
- **Content:**
  - one name for each thing, such as Activity, Inbox with Approve/Deny, everyday and protected
    details, Agent defaults and rules for all agents;
  - no raw ids, tool ids, JSON or zone suffixes;
  - Activity details written in plain English, with technical evidence kept under a disclosure;
  - truthful vault, access-key and code-sent copy.
- **Bugs fixed:**
  - duplicate submissions;
  - a stale page cursor crashing Memory and agent sections (agents' MCP tools still refuse an
    invalid cursor);
  - rules accepting tool names that match nothing;
  - a blank household budget saved as zero;
  - raw household member ids;
  - record names shown as raw kinds;
  - the dev console rotating its key on every visit;
  - "ask to join" early access failing;
  - auth forms submitting as GET before hydration;
  - the unfinishable "approve from another device" sign-in still being offered.

Security behaviour is unchanged: step-up, sessions, passkeys, vault encryption and release,
shown-once values, member scoping, the activity hash chain and deletion semantics.

## Validation

- `npm run typecheck`: clean. `npm test`: 5,685 tests, all passing after one assertion was
  updated for the renamed Cards heading. `npm run build`: compiled successfully.
- Browser: the 594-capture matrix above, plus lane-level flows in throwaway accounts: every
  sign-up, sign-in, recovery and reset step; OAuth consent approve and deny; vault set-up with
  a PRF passkey; card add and remove; disconnect; and passkey removal.

## Open decisions for the founder

- **Missing capabilities**, reported honestly in copy but not built:
  - device approval for `/device` sign-in;
  - authenticator set-up after sign-up;
  - revoking or replacing an access key;
  - reactivating a disconnected agent;
  - device and passkey names;
  - per-service catalogue summaries;
  - a tasks summary and a preferences step on Home.
- **Security trade-offs:**
  - whether sign-up should reveal an existing account earlier;
  - whether to block removing the last passkey on the server;
  - authenticator sign-in shown to everyone;
  - household member emails visible to all members.
- **Content and legal:**
  - the registered operator name and the support mailbox;
  - the "Last updated" date on the policies;
  - a legal read of the vault and card release explainers;
  - rule sentences showing tool ids instead of tool titles.
- **Behaviour to confirm:**
  - Activity date filters now mean days in the account's time zone (previously UTC days);
  - the 4-second copy toast;
  - Home hiding empty panels before the first agent;
  - hiding services that can't be connected yet;
  - the newly shown record fingerprint;
  - "Removed agent" for agents no longer in the account.

## Follow-ups, 13 November

Implemented on branch `claude/uiux-followups` after the pass went live (decisions recorded in
[security follow-ups](../../adr/security-followups-2026-11.md)):

- **Authenticator app:** it can be set up from Settings › Security after a fresh step-up, with
  the same bounded, single-flight, encrypted enrolment rules as at sign-up.
- **Last sign-in method:** the server refuses to remove the only passkey when there is no
  authenticator app.
- **Device sign-in approval:** a member approves or denies a sign-in from another device on
  Settings › Security › Sign-in requests (approval needs a fresh step-up). The push opens that
  screen and carries no id, and sign-in offers the option again.
- **Access keys:** an access-key agent's Settings can replace its key (shown once, old key
  stops working) or revoke it.
- **Status:** disconnected agents read "Disconnected" instead of "Reconnect needed".
- **Rule sentences:** members see tool titles and service names; agents keep the id form.
- **Skills:** skill deletion asks in the page instead of through the browser's `confirm()`.

Still open for the founder:
- reactivating a disconnected agent;
- device and passkey names;
- catalogue summaries;
- a Home tasks summary;
- an earlier existing-account notice at sign-up;
- household email visibility;
- the operator name and support mailbox;
- number matching on device approval;
- removing or replacing an authenticator;
- step-up before revealing a replaced access key.
