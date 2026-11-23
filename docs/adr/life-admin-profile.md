# Life admin as a typed profile, filled in by the person's own agent

Decision date: 23 November 2026. The founder asked for Warthog to hold the admin a person has to
stay on top of. For example, when their motorcycle's rego expires, what its plate is, who insures
it, which health fund and super fund they're with, and what they pay for. The details would be
filled in from the email and documents they connect, so that any agent can answer
"when does my rego expire?" without searching their inbox again.

Before this change, life admin had three kinds of record (subscription, receipt or warranty,
renewal or appointment). Each record's fields were one free-form encrypted blob, with no field
names agents shared, no record of who changed what, no protection against duplicates, and no way
for the person to check what an agent saved.

## How the records get filled in

| | A: Warthog runs a model | **B: the person's own agent** | C: MCP sampling | D: B now, A later |
|---|---|---|---|---|
| Fits the brief | No: breaks `no-ai-model-calls`, `zero-cost-third-parties` and `azure-australia-east` | **Yes**: "all AI work is done by the person's own connected agents" | On paper | Only the B half |
| Privacy | Warthog's servers read mail in bulk and send it to a model provider | Unchanged: the agent the person chose reads what they granted it | As B | — |
| Prompt injection | A model inside Warthog's trusted gate with write access ([read-side protection](read-side-protection.md) rules this out) | The agent's existing exposure, contained by the checks below | As B | — |
| Cost | The founder pays for every scan, forever | Comes out of the person's own subscription | The person | — |
| Build | Large (model integration, queue, cost caps, evaluation) | Medium (catalogue, one migration, upgraded tools, a skill, UI) | Blocked: deprecated in MCP 2026-07-28 and unsupported by claude.ai and ChatGPT | — |
| Future | Fixed running cost, and the model must be kept current | Improves as agents improve; providers' own schedulers can re-run it | Being removed | — |

**Decision: B.** Warthog never reads anyone's email. When the person asks their agent to do it, or
agrees when the agent offers, the agent reads their mail through Warthog's connector tools and
saves what it finds.

Warthog contributes everything plain code can do:
- the record types, as a catalogue;
- a built-in skill holding the search playbook and the rules;
- validation and de-duplication;
- the review state and provenance;
- the checks on what may be stored.

If the founder ever wants Warthog to run extraction itself, it must:
- come with a brief amendment;
- run as an ordinary agent connection, calling these same tools through the same pipeline.

Nothing built here would be wasted.

## Categories and types

`src/domain/life-admin/record-types.ts` defines 12 categories and about 40 types, deliberately
not granular:
- vehicles;
- home;
- utilities;
- other insurance;
- health;
- money & super;
- ID documents;
- work & study;
- subscriptions;
- pets;
- receipts & warranties;
- other.

Each type declares:
- its fields;
- what its due date means (expires, renews, ends, due, return by);
- its default reminders;
- the fields that identify one record of it (insurer + policy number, a plate);
- which assets it can belong to.

**Assets and links.** Vehicles, homes and pets are assets. A rego, a policy or a vaccination
belongs to one through `parent_id`. That gives the "my motorcycle" view and the "all my insurance"
view from the same records.

**How types are stored.** The three original kinds keep their meaning. Every other type is stored
under the new plaintext kind `item`, and its type lives encrypted in `meta`. So the plaintext
columns never say that someone has health insurance or a passport.

## Rules

- **Agents suggest; the person confirms.**
  - An agent's record is `suggested` until the person confirms it in Life admin.
  - Records agents saved before this change also start as suggestions.
  - Agents see `checkedByPerson`. The house skill tells them to say where an unchecked record came
    from, and never to pay, cancel or send because of a record alone.
- **Agents never overwrite what the person checked.**
  - An agent's change to a confirmed record waits in `pending`. The person accepts it or keeps
    their own values.
  - An agent may keep refining its own suggestions.
  - `changed_by` records who changed a record last, so a record an agent rewrote no longer reads
    as the person's. That rewrite used to go unrecorded.
- **One record, not copies.**
  - `match_key` is an HMAC of the type and its identifying values, under a key derived from the
    person's data key.
  - Saving the same thing again updates the record.
  - "Not mine" leaves a tombstone holding only the type and match key, so a later scan doesn't
    bring it back.
  - A match the agent isn't allowed to see is left untouched and never revealed.
- **Never kept.** The checks in `src/domain/life-admin/identifiers.ts` are deterministic: by field
  name, and by value shape together with the words around it.
  - Refused outright: tax file numbers (the TFN Rule binds anyone holding one); passwords, PINs,
    security answers and codes; BSB and account numbers; biller codes and BPAY references taken
    from email; healthcare identifiers.
  - Refused because they belong in the device-held Vault: passport, licence (and licence card),
    Medicare, visa grant and Centrelink numbers.
  - Card numbers are masked to their last four. Links in what an agent saves are cut to the site
    name.
  - The checks run in the MCP input schema, so a refused call is recorded without its parameters
    and the value never reaches the append-only activity record. Page actions and import use the
    same checks.
  - Policy, member, account and meter numbers are everyday details: they are issued by one
    provider and can't prove anyone's identity.
- **The number plate is an everyday detail.** It is displayed on the vehicle, anyone can look up
  rego status from it, and identity checks don't use it. Asking the person's approval every time
  an agent needs it would protect nothing. The Vault's high-tier `car_registration` field stays for
  anyone who prefers to keep it there. This amends the brief's "car registration is high tier by
  default" for Vehicles records.
- **Where a record came from is recorded, and checked where possible.**
  - Agents give `source {service, messageId, date, sender}`.
  - Warthog marks the source `seenByWarthog` only when this agent had just read mail from that
    sender through Warthog (the [read-exposure](read-side-protection.md) window). Otherwise the
    page says "ChatGPT says it found this…".
- **Reminders are calm.**
  - None for dismissed, cancelled, done, paused or expired records, or for anything more than 7
    days past its due date.
  - Several due at once go out as one push per person.
  - A person without a push device is marked handled instead of failing every hour.

## Agents

| Tool | Change |
|---|---|
| `get_context` | Adds `lifeAdmin`: counts by category, up to 5 things due within 60 days (or up to 30 days overdue), and how many wait for the person. Counts cover exactly the records this agent may see. An agent that can read the person's mail and save records gets `next`, a one-line offer to make once when life admin is mostly empty. |
| `list_records` | Filters by category, type (`*.insurance`), words, due window and parent, and pages with a cursor. Each record comes labelled with its type, field labels, `due {date, label, inDays}`, `savedBy`, `checkedByPerson` and where it was found. Recurring costs come with a monthly total worked out by Warthog. Cancelled and ended records are left out unless asked for. |
| `save_record` | Takes typed records, or a batch of up to 25 with `ref`/`parentRef` to save a vehicle and its rego together. Calls with the older `kind` still work. |
| `update_record` | Takes `set` as a patch (`null` removes a field). Can link a record to its parent, or give an older record its type. |

There is no new core tool: client tool budgets matter, so the count stays at 16.

**The "Life admin records" skill.** It is a built-in skill, listed for agents with the records
permission. It is generated from the same catalogue `save_record` validates against, so the two
can't drift. It covers:
- the types and their fields;
- bounded Gmail and Outlook searches per category;
- what never to save;
- how to save and answer.

## Known limits and follow-ups

- **PDFs.** Agents can't read Gmail attachments or Drive PDFs, where policy schedules often sit.
  Email bodies usually carry the renewal date and premium.
- **One date per record.** A receipt reminds for its return-by date. Its warranty end is a field
  that doesn't remind.
- **No recurrence.** A monthly subscription's next renewal date doesn't roll forward by itself yet.
- **No per-category grants.** Agents with records access see every category. A separate grant for
  health or money is a possible follow-up; [resource audiences](resource-audiences.md) chosen
  records still apply.
- **Record values in activity.** Saved record values still reach the (encrypted, redacted)
  activity entry for the call, like memory content does. Activity entries that keep only the
  fields' names, not their values, are a follow-up.
- **Reminder email fallback.** People without a push device get no reminder by email yet.
