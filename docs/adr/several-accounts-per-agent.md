# One agent, several accounts of a service

Decision date: 24 November 2026.

The founder has three Gmail accounts connected and wants one agent to use all three at once:

> "I should be able to see each gmail as its own respective connector in the connected services
> list instead of clicking on the dropdown menu in the Gmail connector and switch between only one."

Until now an agent was given a SERVICE. If the person had more than one account of it, the agent
was set to one of them (`connector_accounts`). Settings applied to the whole service
(`connector_policies`). The [accounts ADR](google-published-and-accounts.md) left this "Not done",
along with a disconnect bug: removing one of several accounts took the whole service away from
agents with no account chosen, and left stale choices behind.

## Decision

1. **An agent is given accounts.** The new table `agent_account_grants` (migration 0122) has one row
   per agent and account.
   - Each row carries the account's own read, change and tool settings. NULL means "the same as
     this agent".
   - A service is granted when at least one of its accounts is.
   - Both foreign keys carry the person, so a grant can't point at another person's agent or
     account.
   - Disconnecting an account removes its grants by cascade. The service's other accounts stay
     granted, and no stale choice is left.
   - Connecting another account grants it to no one.
2. **Tools stay one set per service.** Every connector tool takes an optional `account`: the account's
   address or label (any case), or its handle.
   - ChatGPT and claude.ai keep their own copy of the tool list, and clients have tool budgets, so
     there are no per-account tool copies.
   - A client with the older list can name the account inside `query` on Google, Microsoft and
     LinkedIn tools. It is never lifted from the general request tool, whose query goes to the
     service as it is.
3. **Every connector call is bound to one granted account BEFORE the policy runs**
   (`src/domain/permissions/account-access.ts`). The policy therefore checks that account's own
   settings, and the hold, execution and Undo use it. Binding works in this order:
   - an account Warthog bound earlier (an approved request, an Undo) must still be granted;
   - a named account must be one of the agent's own;
   - with none named, the only granted account is used, or the only one whose settings allow the
     tool.

   Otherwise the call is refused with the choices. Binding never falls back, and an account that
   needs reconnecting is never swapped for another. The refusal for an account the agent wasn't
   given reads the same whether or not the account exists. This supersedes the single-account
   sentence in [agent-first-management](agent-first-management.md).
4. **The agent learns its accounts from `get_context`.** `serviceAccounts` lists each granted account
   as `{service, account, handle, status, reads, changes, tools}`. No internal ids reach the
   agent, and `permissions.servicePolicies` is folded into these entries.
5. **Mail searches every inbox at once.** A Gmail or Outlook search with no account named covers
   every inbox the agent may read:
   - at most 5 inboxes, one shared limit of 6 requests at a time, and one overall deadline;
   - each inbox's result is checked by the result guard with its own account, then merged newest
     first;
   - the result says which inbox each email is in, and which inboxes were searched or skipped;
   - message and thread ids carry their inbox (`<handle>.<id>`), so reading and replying go to the
     right inbox even from a client that can't add fields;
   - a reply is sent from the inbox that holds the email, and a different `account` is refused;
   - a new email needs the agent to name the From account when more than one may send.

   There is no new "main account" setting. Changes are never fanned out. A search never waits for
   approval: an inbox whose rules ask first is left out and named, and the agent can search it on
   its own, which asks.
6. **Several accounts of a service can be "On for new agents".** This supersedes "at most one" in
   [default-services](default-services.md). The consent and access-key screens list each account as
   its own checkbox, which supersedes "multiple accounts still require selection" in
   [agent-connection-consent](../design/agent-connection-consent.md).
7. **The agent page lists one row per account** inside the Connected services panel (UI/UX audit
   W-35: divider rows, not cards inside cards). Each row has the account's own switch and settings,
   and the account dropdown is gone.

## Rollout

The old columns `granted_connectors`, `connector_accounts` and `connector_policies` keep a copy for
one release, so a rollback to the previous image stays safe:

- a service with one granted account is set to it;
- a service with several is left without one, which the previous release refuses.

A rollback therefore narrows access and never widens it. A later migration drops the old columns.
Migration 0122 carries access over exactly:

- a service's chosen account, or its only account, keeps the service's settings;
- a service with several accounts and none chosen gave no access before, and still gives none.

## Not done

- **Rules still apply to a whole service.** A Gmail rule covers every Gmail account. Limits for one
  account come from that account's row.
- **Calendars, Drive, OneDrive, Notion, LinkedIn and Amadeus** can be given several accounts. When
  more than one is given, the agent names the account on each call; there is no combined calendar
  view yet.
- **Send-as aliases** are not offered.

## Consequences

- **Brief amendments:** "Connect a service once", "Agent consent screen" and "Per-agent permissions
  page".
- **Design doc:** technical-design.md §6.2 and §7.
- **Migration 0122:** a new table with its own grant to `warthog_app`, plus the backfill.
- **No new settings and no new approvals.**
