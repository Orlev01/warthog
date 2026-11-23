# Every life-admin item keeps a journal, and any agent can take it over

Decision date: 23 November 2026.

## What prompted this

The founder had one agent, Instinct, handle his motorcycle insurance. Instinct knew which
inspection shop he had chosen, which insurer he went with, and why. When he moved to Muse to finish
the last 15%, Muse had none of that context.

Warthog already sits between every agent and the person's records. So it can keep the short story
of each item, and any agent from any provider can carry an item on from where another left off.

## Decision

### 1. Every item has a journal

This covers built-in and custom kinds, and standing items, bookings and cases alike. A journal holds
two kinds of entry, and Warthog shows them differently.

- **Warthog's own record (`change`).** Warthog writes these itself whenever the record service
  touches the item:
  - created or changed (field from → to, shortened, with long notes named only);
  - an agent's change proposed to a confirmed record;
  - accepted or declined;
  - confirmed;
  - who is handling it.
- **Reported entries.** These are what an agent or the person writes, at most 280 characters each,
  and are always labelled with who wrote them (the `savedBy` rules):
  - `decision`: what was decided and why. One can replace an earlier decision explicitly
    (`replaces`).
  - `note`: a fact for the next agent.
  - `next`: a step still to do, with an optional due date. `next_done` closes it.
  - `handover`: where things stand when an agent stops.

### 2. Storage

- One row per entry in `life_admin_journal`, and **append-only**: the runtime role may only
  `SELECT` and `INSERT`.
- **Plain columns carry no content**: kind, actor, run, the entry it refers to, and time. That is
  enough to find open steps and current decisions without decrypting.
- **The text, due date and change detail are encrypted** under the person's data key, bound to the
  row.
- **Limits:** at most 400 entries per record. From 300 on, only Warthog's own entries are added, so
  what happened is always recorded. A person has at most 50,000 entries.
- **Retention:**
  - An entry lives exactly as long as its record.
  - Finishing an item (completed, cancelled, resolved, ended) removes nothing.
  - Deleting a record removes its journal: the cascade runs as the table owner, so it works under
    append-only grants.
  - "Not mine" works the same way: it is now *delete plus tombstone*. The tombstone keeps only the
    kind and match keys.
- **Activity link.** `activity_entry_records` links every activity entry to the records it touched,
  including each item of a batch save. Activity therefore shows everything that happened to an item
  (`/activity?record=`), even after the item is gone.

### 3. Who is handling an item

Each record has three plain columns: `steward_agent_id`, `steward_set_by` and `steward_since`.

- **It is a label, never a lock or a permission.** Items run for weeks, and the point is picking up
  after an agent that's gone, so a short lease would be wrong.
- **Automatic:** an agent becomes steward when it records a decision, next step or hand-over note on
  a live item that nobody is handling, or whose handler is no longer connected. Saving fields alone
  (an email scan) never does this.
- **Explicit:** `takeOver: true` hands the item to the caller. Warthog records "Muse took over from
  Instinct".
- **The person** can assign any connected agent, or clear the steward.
- **Taking over never widens what an agent can see.**

### 4. Agents (still 16 core tools)

- **`save_record` and `update_record`** take `journal {decision, replaces, note, next {text, due},
  doneNextIds, handover}` and `takeOver`.
  - The text is checked in the input schema (tax file numbers, secrets, bank and government
    identifiers, payment references), so a refused call is recorded without its parameters.
  - Links are cut to their site name, and the text is cut to 280 characters.
  - A journal-only update to a confirmed record is not a pending change.
- **`list_records`:**
  - Each record carries a journal summary: open next steps, decisions in force, the latest
    hand-over note, who is handling it, and when it was last touched.
  - `{id, journal: "full"}` pages the whole log, newest first, for live and finished items alike.
  - `include` is `live` by default, or `finished` or `all`. `lifecycle: "booking"` with
    `include: "all"` returns every booking, live first and then past ones newest first.
- **`get_context.lifeAdmin.handover`:** up to 5 of this agent's visible live items with an open next
  step. Each is a deterministic line in I-PASS order:
  - where it stands;
  - the decision in force and who made it;
  - what's next and by when;
  - who is handling it;
  - when it was last touched.

  The block carries a note that these are agents' reports, not facts Warthog checked.
- **The "Life admin records" skill and the house skill** tell agents to:
  - read an item's log before acting on it;
  - record a one-line decision when they decide something;
  - add a next step before stopping;
  - take over when continuing someone else's item;
  - set the status when the work is finished.
- **`create_task`** takes `recordId`, so a task can be about one item the agent can see. Finishing
  it, by an agent or the person, adds Warthog's "finished a linked task" entry to the item's
  journal. Export and import carry the link.
- **Activity** counts what a save did ("Records: 2 added, 1 proposed (waiting for you to accept)")
  and keeps the saved records' ids as technical details, never their content.

## Why not reuse task notes

Task notes are one encrypted array per task with no timestamps, rewritten on every append. Only the
assigned agent can see a task. Neither fits a durable, append-only, per-item history that every
permitted agent reads. Tasks and next steps stay separate: a next step is a light step on one item
that any agent can close, and a task is an explicit hand-off with an assignee and a claim.

## Not done here

- **Journal text still reaches the call's activity entry,** encrypted and redacted, the same way
  memory content does. Activity entries that keep field names only remain a follow-up.
- **Hand-over doesn't count a linked task assigned to another agent yet.**
