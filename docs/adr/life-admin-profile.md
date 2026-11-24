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

## Categories and types (amended the same day: life areas, bookings, a person's own categories)

**Filed by what it's about.** Records are filed by the thing they're about (the motorcycle, the
home, health), not by what kind of paperwork they are. People's questions are about things, and every
record then has one obvious home. "What do I pay for" and "all my insurance" are views calculated
across categories (monthly totals, `*.insurance`), not filing places.

**Checked against real data (amended 23 November 2026).** The founder asked whether, after agents
had filled Life admin from two real inboxes, filing by document type would be better.

- **The answer stays "what it's about".** Filing has three separate jobs:
  - **What it's about** decides where a record is filed.
  - **Where it stands** (active, on hold, finished or cancelled) decides how the Records tab reads.
  - **Where it came from** (the email that showed it) is why it's believed.
- **Many documents describe one thing:**
  - the motorcycle's rego appears in three emails (a renewal notice, last year's receipt and the
    CTP purchase);
  - a Queenstown trip appears in seven (flight, stay, receipt, an extra charge, a sauna booking
    and an eSIM);
  - AGL sends a new bill every month.

  Filed by document type, these become many unconnected records. Matching instead of duplicating,
  anchors, live versus finished, and the journal would all be lost.
- **Agents file by subject reliably.** ChatGPT chose the right subject kind for all 19 records that
  an older tool schema had filed under Other.
- **Document type already has its job:** agents search by it ("renewal notice", "booking
  confirmation"), and it becomes the record's provenance.
- **What made the page hard to read was status, not subject.** The Records tab fixes that.
- **Two refinements came out of the data:**
  - Receipts, subscriptions and memberships can belong to any thing, as insurance and domains
    already can. An eSIM is filed under the trip it was for, and a software plan under the business
    that pays it.
  - The Records tab shows what the active, recurring records in the chosen categories cost a month
    (`src/domain/life-admin/costs.ts`, which `list_records`' `monthlyCost` also uses).

**The catalogue.** `src/domain/life-admin/record-types.ts` holds 20 built-in categories (19 plus
Other) in 8 life areas. They come from the research and from a sample of the founder's own inbox.
- **Home:** home; utilities.
- **Getting around:** vehicles; trips and travel.
- **Health and care:** health; care and support.
- **Money:** banking and credit; super and investing; tax and government.
- **Papers:** personal insurance; ID and residency; legal and estate.
- **Work:** work and study; business.
- **Family:** kids and family; pets.
- **Everyday:** purchases and belongings; subscriptions and memberships; going out; other.

They hold about 85 kinds.

**Lifecycles.** Every kind is one of three:
- **standing:** an account, policy or document that renews or expires;
- **booking:** booked for a time, live until it's over, then finished;
- **case:** a fine, claim, application or dispute, open until resolved.

Bookings and cases are kinds filed where they belong (a dentist in health, a car service in
vehicles, a flight in travel). A cross-category Bookings view lists every booking, live and past.

**Fields every kind shares:**
- common to all: name, provider, reference, amount, currency, cycle, `for_whom` (a first name or
  relationship), contact, email, website, notes, plus up to 20 labelled details;
- bookings add start and end date-times, each in its own time zone (place, party size, booked via,
  deposit, card held, cancel by, hold until);
- cases add opened, stage, next step, waiting on and outcome.

**Relationships are generic.** Any kind may be an anchor (others belong to it), and a kind says
which anchors it may belong to (`belongsTo`, or "any").
- One rule in the catalogue (`canBelongTo`) decides every link, built-in or custom. An anchor never
  belongs to another anchor.
- Bookings, cases and other insurance can belong to any anchor.
- A trip's dates are worked out from its bookings when it's read.

**A person's own categories.** People's lives differ, so the built-ins are a seed, not the whole
list.
- **Hidden until used:** a built-in category shows once the person has something in it; they can
  also say "not for me", which hides its records too. (The earlier "Show" setting, which kept an
  empty category on the page, no longer has a control: see [The Records tab](#the-records-tab).)
- **Suggested when nothing fits:** the person's agent may suggest a category in a fixed, generic
  shape:
  - a label, description, life area and icon;
  - up to 4 kinds, each with a lifecycle, a use line, an optional due date, up to 12 fields of a
    closed set of 18 field kinds, an identity, and anchor / `belongsTo` links.

  Warthog validates it deterministically in the input schema (`./custom-category.ts`):
  - plain labels, with no links or long digit runs;
  - no field names Warthog never keeps, no health details, no reserved names;
  - no built-in under another name: "Flights" is redirected to `travel.flight`;
  - at most 12 categories of the person's own and 3 suggestions waiting.
- **Stored per person.** These categories live in `life_admin_categories`, under a random id
  (`x_7kq2mz`), with everything that names them encrypted.
- **Shown to the person as suggested.** A suggestion shows at once, marked suggested, with the
  agent's reason. Confirming any of its records, or pressing Keep, keeps it. Declining it:
  - turns its suggested records into tombstones;
  - moves any confirmed record to "Something else";
  - keeps the label, so the same suggestion isn't accepted again.
- **Shown to other agents as data.** Agents see these labels quoted as data.

**Everything goes through the person's catalogue.** `./catalogue.ts` merges the built-ins with the
person's own categories, and every reader goes through it: validation, the page, the skill and
import. Nothing looks a kind up statically. (The moving checklist, which also read it to find the
kinds that hold the person's address, was removed at the founder's request on 23 Nov 2026, along
with that "holds the address" flag.)

**How types are stored.** Every kind beyond the original three is stored under the plaintext kind
`item`, with its kind encrypted in `meta`, so no plaintext column says what someone has. A
booking's detailed state (pending, confirmed, cancelled, no-show) is also encrypted. Its plaintext
status is the coarse active, cancelled or done.

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
- **One record, not copies.** A kind has identity *alternatives*: a booking matches on provider +
  reference, or on provider + start date. Every alternative a save can fill is stored as a match key
  (`match_keys`), so a booking first saved without its reference still matches once the reference
  turns up.
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
- **Live or finished is worked out, never stored.** `./lifecycle.ts` is the one place it's decided,
  replacing five copies. A booking finishes by time, read in its own zone. A standing item or case
  finishes only when someone sets its status. Agents see live records by default; finished ones keep
  their history and stay one call away.
- **Reminders are calm.** The keyless sweep reads a plaintext `remind_until` worked out on every
  write: due date + 7 for a live item, the start date for a booking, none for anything finished,
  paused or undated.
  - None for dismissed, cancelled, done, paused or expired records, or for anything more than 7
    days past its due date.
  - Several due at once go out as one push per person.
  - A person without a push device is marked handled instead of failing every hour.

## The Records tab (amended 23 November 2026)

The founder found the first page unreadable: a tab called "Your things", 17 empty "Nothing here
yet" panels before any record (every built-in category had been set to show), each category mixing
live records with a "Finished (n)" group, and rows listing every fact. He asked for a plain tab
name, filters by category and by status (both multiple-choice), and what's active first, always.

- **The tab is Records** (`?tab=records`). Its count is what's active. The old key (`things`) and
  the older reminder-link tabs (subscriptions, receipts, renewals) still open it; Home, Bookings,
  the item page and the notices link to it.
- **Four statuses, worked out from the phase** (`listStatusOf` in
  `src/components/life-admin/record-groups.ts`, never stored):
  - **Active:** current, due soon, overdue, date passed, waiting to be confirmed, upcoming,
    happening now, open, waiting.
  - **On hold:** paused.
  - **Finished:** ended, completed, resolved (a standing item expired or done, a booking that's
    over, a case resolved).
  - **Cancelled:** cancelled, missed, lapsed, and a standing item whose status is cancelled.
- **Two filters, each multiple-choice:** Category (every category with a record, in catalogue order,
  the person's own included; none ticked means all) and Status (default Active). They are repeated
  GET parameters (`?category=vehicles&category=health&status=active&status=finished`) in a plain
  GET form with an Apply button, so they deep-link and Back/Forward restore them; with JavaScript a
  tick applies at once, in place, keeping the scroll position. The page validates them against the
  person's catalogue and the four statuses (unknown values are dropped, no status means Active) and
  the view filters; each option shows how many records it would show with the other filter as it
  is. Applied filters show as removable chips, and one line says what's shown and what isn't
  ("7 active · Not shown: 1 on hold, 2 finished, 1 cancelled"), each part not shown a link that
  adds it. The control is the shared `MultiSelectFilter` (`src/components/ui/multi-select-filter.tsx`);
  Bookings uses it for its Category, For and State filters, sharing `category` with Records.
- **Active first, then the rest:** what's active is one panel per category with something active,
  in catalogue order, anchors heading their records, most urgent first (overdue and date passed,
  happening now, due soon, then by date, then undated by name). Each other chosen status follows as
  its own quieter list across categories (On hold, Finished, Cancelled), newest first, each row
  naming its category. Statuses never mix, and no panel is ever empty: a filter that matches
  nothing shows one empty state with Clear filters.
- **Compact rows:** the name (a link to the item's page), where it stands, "Not checked yet", one
  muted line (kind, when it's due, renews or starts, cost and cycle, provider) and who's handling it
  with the next step. Facts, reminders, provenance, downloads and the controls are one click away in
  the row's Details. A record action returns to the filters it was submitted under; a link to a
  record the filters hide opens the item's page, whose Back link shows that record's status.
- **To check** stays above the filters, whatever they are. "Accept all n changes" accepts every
  waiting change at once (member-scoped, audited like Confirm all). A change that gives a record
  another kind reads first ("Kind: Renewal or appointment → Vehicle (Vehicles)"), without the old
  schema's removed `type` and `source` fields; it needs the waiting change to carry the new kind.
- **Fill in the rest** offers up to six empty built-in categories the person hasn't said are not
  for them, with "Not for me" only, and the prompt to copy.

## Four tabs, account details and plain reminders (amended 23 November 2026, later)

The founder looked again and asked for Life admin to be easier to make sense of:

- **Tabs.** "Can we remove 'Records (20) Upcoming (2) Bookings (0) Moving checklist (0)' and instead
  just have 'Records' and 'Upcoming' and 'History' and 'Tasks'."
- **Bookings.** "Bookings should be folded into Upcoming."
- **What each tab is for.** Records is "a list of all current services, applications, things that
  are just active and ongoing in my life". Upcoming is "attention and actions some records expect of
  me". History holds "events that have passed", kept "strictly separate as they are more a log".
- **The moving checklist.** "Please remove it completely."
- **Data.** "What is my account name, what is my account number, what email address is it
  associated with … meaningful data should be carried over and stored."
- **Reminders.** "What is 'Remind me (days before)'? Remind me for what?"

**One row of tabs: Records | Upcoming | History | Tasks** (`?tab=records|upcoming|history|tasks`;
Records has no parameter). There are no counts in the names, and no "Records & reminders" level
above them. Where each record lives is one rule, `sectionOf` in
`src/components/life-admin/record-groups.ts`, worked out from the phase and never stored:

- **History:** anything finished, of every kind: a past or cancelled booking, something ended or
  cancelled, a resolved case.
- **Upcoming:** a live booking, or a trip (the anchor bookings belong to).
- **Records:** everything else, which is accounts, policies, memberships, documents, the things
  other records belong to, and matters in progress.

Records' Status filter offers Active and On hold only. Its status line says how many finished
things are in History, with a link. History has its own multiple-choice Category and Status
(Finished, Cancelled) filters (`?history_category=…&history_status=…&history_page=…`). It lists
newest first, by the month each thing happened (its start, else its date, else when it was bought
or opened; the undated last), 30 to a page. Each row is the same row as on Records, and an action on
it comes back to History. Upcoming keeps happening now, overdue, this week and later (60 days), then
adds every other live booking: further ahead, and those with no date yet. A renewal coming up shows
on both Records and Upcoming. To check stays at the top of Records for every suggestion, whichever
tab the record will live on.

**Older addresses are redirected, after sign-in** (`currentLifeAdminHref` in
`life-admin/form-inputs.ts`), keeping the rest of their query:

- `?view=tasks` goes to Tasks.
- `?view=life&tab=bookings` goes to Upcoming. The Bookings tab's own `for_whom`, `state` and `page`
  filters are dropped.
- The checklist and the older tab names go to Records.

Reminder notifications keep their `?view=life&tab=renewals#record-…` links, because installed
service workers only let those through. The fragment survives the redirect. A `#record-` that isn't
a row on the tab shown (a booking, something finished) opens the item's page.

**The moving checklist is gone:**

- The tab, the builder, the store and their tests are removed.
- Migration 0121 drops `moving_checklist`. Its items were worked out from addresses and records, so
  nothing the person wrote is lost.
- The catalogue's `holdsAddress` flag is removed, and so is the landing card.
- An address's moving date stays in About you, and agents still get the upcoming address until the
  day.

**Account details.** Kinds the person holds an account, policy or membership with are marked
`account` (31 built-in kinds; a person's own standing kind can take `account: true`). Each gets two
fields beside its number, `ACCOUNT_FIELDS` in `record-types.ts`:

- `account_name`: the name the account is in, as the provider shows it.
- `account_email`: the email address it's registered to. This is the person's own address only;
  someone else's is their personal detail.

Their fields lead in that order: name, provider, account name, number, account email. The number
stays `reference`, named by the kind ("Member number", "Policy number", "Account number"). Things,
ID documents, bookings, cases, government records, scripts and receipts aren't accounts. A bank
account or card still keeps only its last 4 digits.

The skill gains "What to carry over":

- these three details, then the plan, cost and cycle, and the date;
- only what someone needs to act later;
- no balances, transactions or marketing;
- notes in the agent's own words;
- `update_record` with `set` to fill them in on records saved without them.

The skill's size guard moved from 32,000 to 33,000 characters, after trimming its repeated field
lists.

**Reminders say what they're for.** A record with no date shows nothing about reminders. One with a
date says when, against the date ("Reminds you 14 days and 1 day before · Expires 14 Dec 2026"). A
"Change reminders" choice of days sits under that line: 30, 14, 7 and 1 days before, on the day, and
any other day the record already has. Unticking them all turns reminders off. The typed "days
before" list is gone, and a form left open with it still saves.


### The Add tab (amended 24 November 2026)

The founder asked to keep what is on file apart from what is still to fill in: the "Fill in the
rest" and "Add something yourself" panels at the bottom of Records "need to be distinct from the
record tab … which captures things that already exist … The idea is to separate the two concepts
of items that already have data and items that do not." They chose a new tab named **Add**, right
after Records.

**Records | Add | Upcoming | History | Tasks** (`?tab=add`):

- **Records** keeps only what is on file: To check, the filters, what's active by category and
  what's on hold, then an "Add a record" link to Add. With nothing on file it says so ("Nothing on
  file yet.") and links to Add.
- **Add** holds Fill in the rest (the empty categories to look for, the prompt for an agent, and
  Not for me, to undo) and Add something yourself (pick a kind, then its form). Choosing "Not for
  me" or Undo comes back to Add. A record added there lands where it lives (Records, or its own
  page when it's a booking or finished); a problem keeps the person on Add with the form open.
- **Which tab opens.** An address without `?tab=` opens Records, or Add while nothing is on file
  (`nothingOnFile`: no record shown on any tab and nothing to check; when everything kept is in
  categories marked not for them, Records says so). Picking a kind to add (`?add=`) opens Add.
  Older addresses and reminder links map as before, and an old `/life-admin#new-record` link
  reloads at `?tab=add#new-record`. The browser's address then names the tab shown whenever it
  isn't this person's default (`shownLifeAdminAddress`), and the shared tabs show the page's tab on
  load when the address names none, so the server and the browser never disagree.
- **Links between tabs open in place.** "Add a record" and Upcoming's "Add a booking" switch tab
  without reloading (`ViewTabLink`), so what's half-typed in other tabs survives; without
  JavaScript they're plain links.
## Agents

| Tool | Change |
|---|---|
| `get_context` | Adds `lifeAdmin`: counts by category; up to 5 things due or starting within 60 days (or up to 30 days overdue), each with its phase; how many wait for the person; open cases and upcoming bookings; the person's own categories, "not for me" ones and how many built-ins are unused; `otherMailAccounts`; the hand-over block. Counts cover exactly the records this agent may see. An agent that can read mail and save records gets `next`: an offer to fill life admin in, or to find bookings. |
| `list_records` | Filters by category (built-in or the person's own), kind (`*.insurance`), lifecycle (booking, case), words, `forWhom`, due window and parent, and pages with a cursor. `include` is `live` by default, or `finished` or `all`. `id` returns one record whatever its phase, and `view: "categories"` lists categories. Each record comes labelled with its kind and category, field labels, `due`, `phase`, `savedBy`, `checkedByPerson`, where it was found, who is handling it, and a journal summary. Recurring costs come with a monthly total worked out by Warthog. |
| `save_record` | Takes typed records, or a batch of up to 25 with `ref`/`parentRef` (a trip and its flights; a vehicle and its rego). Also takes `details`, `journal` and `takeOver`, and `newCategory` to suggest a category of the person's own whose kinds the call's records use as `new.<kind>`. Calls with the older `kind` still work. |
| `update_record` | Takes `set` as a patch (`null` removes a field), `details`, `journal` and `takeOver` (journal-only updates are fine). Can link a record to its parent, or give an older record its kind. |
| `create_task` | Takes `recordId`, for a task about one item. |

There is no new core tool: client tool budgets matter, so the count stays at 16.

**Agents with an older copy of the tools (amended 23 November 2026).** Some apps keep the tool
list they fetched when the person connected them: ChatGPT keeps it until the person refreshes the
connector, and the claude.ai connector keeps it too. After this release, such an agent read the new
skill but could only send `kind` and `fields`. So it put `type` and `source` inside `fields`, and
the founder's records landed under Other as "Renewal or appointment", with their kind and source
shown as two fields.
- **Lifting the older shape.** The MCP dispatch lifts a record tool call in that shape into today's
  parameters before the SDK checks it, and each record tool does the same.
  - The lifted parameters are `type`, `source`, `details`, `journal`, `parentId` and `takeOver`
    found inside `fields`, plus parameters sent as JSON text.
  - Only what is unmistakable is lifted: a kind id, an object for `source`, a list for `details`.
  - A current call is unchanged, and a field named `type` that isn't a kind id stays a field.
- **The skill** tells such an agent to do this, and to ask the person once to refresh or reconnect.
- **Moving records an agent already saved.** An agent can move such a record into its kind with
  `update_record {type}`. On a record the person has checked, that change waits as a pending change.
  A pending change now carries the new kind, the parent it links to and a booking's or case's state,
  and accepting it applies all three.

**The "Life admin records" skill.** It is a built-in skill, listed for agents with the records
permission. It is generated from the same catalogue `save_record` validates against, so the two
can't drift. It covers:
- the kinds and their fields (the person's own categories quoted as data);
- bounded Gmail and Outlook searches per category, across every connected mail account;
- bookings (schema.org reservation mapping, one record per flight leg, forwarded bookings, trips);
- cases;
- working on an item over time (the journal);
- when nothing fits: suggesting a category;
- what never to save;
- how to save and answer.

Each item's journal and hand-over between agents is in [the journal ADR](life-admin-journal.md).

## Known limits and follow-ups

- **One mail account per service per agent.** The founder keeps bookings and billing in separate
  Google accounts, but an agent reads only the account it was given for each service. `get_context`
  hints with `otherMailAccounts`.

- **PDFs.** Agents can't read Gmail attachments or Drive PDFs, where policy schedules often sit.
  Email bodies usually carry the renewal date and premium.
- **No parcels or deliveries in v1** (founder decision).
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
