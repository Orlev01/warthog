import { activityEvidence, withoutMatchedIntents } from "@/domain/activity/evidence";
import { readDisputesForEntries } from "@/server/activity/disputes";
import { formatAccountTime } from "@/server/display-time";
import { timeZoneNote } from "@/domain/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";
// E08-S07 — Activity page server actions (dispute, undo, check integrity).
//
// The Activity screen's controls must call server-verified actions — the acting
// person is the VERIFIED Session's user id, never a client-supplied value (design
// §5: every member-scoped query is filtered by the session's user id). This factory
// is the testable core the thin `page.tsx` loader composes: it reads the session +
// the process-wide database, builds the sub-services (the dispute repo E08-S03, the
// undo service E08-S04, the integrity check E08-S02) and renders the view; the
// logic that turns a verified session into a dispute / undo / integrity outcome
// lives here.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file
// may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The testable logic lives here,
// the convention's `createXActions(deps)` pattern — exactly as the sibling security
// page uses `createSecurityActions(deps)`.
//
// Security (each a reviewer veto; design §5, INV-102/103):
//   • Every action derives the acting user id from `session.userId` — never a
//     client-supplied value. There is no `userId` parameter on any method.
//   • disputeEntry / undoEntry validate `entrySeq` at the boundary and REJECT
//     anything that is not a POSITIVE INTEGER with a 4xx `HttpError` (OBS-049), so a
//     bad id never reaches a query as a raw cast. An over-long / mis-shaped note or
//     reason is likewise rejected with a 4xx before any query runs.
//   • A well-formed id that is simply not this person's (or declares no reversal)
//     returns { ok: false } with a plain-words reason and changes nothing — a
//     reported refusal, never a silent success and never another person's row.
//   • Every statement under these actions is parameterized through the injected
//     seams (INV-102). This module reads no `process.env` and holds no secret
//     (INV-103): the db and both sub-services are INJECTED.

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import {
  checkIntegrity as runIntegrityCheck,
  type IntegrityResult,
} from "@/server/activity/integrity";
import { listActivity, listActivityFacets, summariseActivity, type ActivityFilters, type ListedActivityEntry } from "@/server/activity/list";
import { isReadOnlyTool } from "@/server/activity/tool-effects";
import { activityCategory, agentRole, CATEGORY_LABELS, outcomeGroup, outcomeLabel } from "@/domain/activity/category";
import type { Clock } from "@/server/seams/clock";
import {
  ACTIVITY_PATH,
  NONE,
  activityHref,
  agentGroups,
  appliedFilters,
  breadcrumb,
  countsCaption,
  dayEndIn,
  dayOf,
  dayStartIn,
  filtersFor,
  quickLinks,
  readActivityState,
  serviceGroups,
  stateQuery,
  timeOfDay,
  typeGroups,
  viewLinks,
  type ActivityState,
} from "./organise";
import { calendarReversalForEntry } from "@/server/activity/calendar-reversal";
import { getUserById } from "@/server/db/users";
import { agentNamesForUser, listAgentsForUser } from "@/server/db/agents";
import { agentLabel, entryTitle, kindLabel } from "@/domain/activity/describe";
import { platformLabel } from "@/components/agents/platform-label";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { UndoRefusalStatus } from "@/server/activity/undo";
import type {
  ActivityEntryView,
  ActivityViewProps,
} from "@/components/activity/activity-view";
import type { Session } from "@/server/auth/session";
import type { Db } from "@/server/db/index";

// The sub-services the actions drive, declared as the MINIMAL behaviour each action
// needs (not the concrete exported type names) so these actions couple to behaviour
// — the real `DisputeRepo` / `UndoService` and a recording test stand-in both
// satisfy them. disputeEntry only files; undoEntry only undoes.
interface DisputeFiler {
  fileDispute(input: { userId: string; entrySeq: number; note: string }): Promise<unknown>;
}
interface EntryUndoer {
  undo(input: { userId: string; entrySeq: number; reason?: string }): Promise<
    { ok: true; entry: { seq: number } } | { ok: false; reason: string; status?: UndoRefusalStatus }
  >;
}

// The dependency bundle: the parameterizing db seam (the integrity check and the
// loader's member-scoped reads use it) plus the two composed sub-services. The
// loader-only seams are OPTIONAL so the E08-S07 construction (dispute/undo/integrity
// only) still compiles — `load` requires them and reports loudly if they are absent.
export interface ActivityActionsDeps {
  readonly db: Db;
  readonly disputes: DisputeFiler;
  readonly undo: EntryUndoer;
  // Resolves the SESSION person's DEK: getUserById(session.userId) then
  // keyWrapper.unwrap(user.wrappedDek) — the session→DEK idiom loadAgentContext uses —
  // so the loader can decrypt the person's own entries to list and search them.
  readonly keyWrapper?: KeyWrapper;
  // The "is this reversible?" decision the undo service already takes; the loader uses
  // it to set each entry's `canUndo`, so an Undo control shows only where a reversal is
  // declared.
  readonly reversalFor?: (tool?: string) => string | undefined;
  // How many of the newest entries one view reads and decrypts (default
  // ACTIVITY_PAGE_LIMIT, or ACTIVITY_SEARCH_LIMIT for a search), so a long history is never
  // decrypted whole.
  readonly pageLimit?: number;
  // "Now", for the timeline's "Today"/"Yesterday" headings. Absent ⇒ dated headings only.
  readonly clock?: Clock;
  // Names a connected service through the connector catalogue (the page passes the
  // process-wide index), so entries and the service filter show "Google Calendar" rather
  // than its id; absent, or a service the catalogue doesn't know, ⇒ the id is shown.
  readonly serviceName?: (connectorId: string) => string | undefined;
}

// The Inbox opens one approval at `/inbox?approval=<id>` — the deep link a push notification
// uses (public/sw.js) — marking it and bringing it into view.
function approvalHref(approvalId: string): string {
  return `/inbox?approval=${encodeURIComponent(approvalId)}`;
}

// The newest entries the Activity timeline shows at once, and how many a free-text search
// scans (search can only match decrypted text, so it reads a larger bounded page).
export const ACTIVITY_PAGE_LIMIT = 100;
export const ACTIVITY_SEARCH_LIMIT = 500;

// A dispute / undo outcome: success, or a refusal naming its reason in plain words
// (never a silent success, never a silent failure).
export type DisputeResult = { ok: true } | { ok: false; reason: string };
export type UndoResult =
  | { ok: true; entry: { seq: number } }
  | { ok: false; reason: string };

// The activity actions the loader + its server-action wrappers drive.
export interface ActivityActions {
  disputeEntry(session: Session, entrySeq: number, note: string): Promise<DisputeResult>;
  undoEntry(session: Session, entrySeq: number, reason?: string): Promise<UndoResult>;
  checkIntegrity(session: Session): Promise<IntegrityResult>;
  // Turn the verified session + the view's GET params into the ActivityView's props:
  // the session person's OWN entries (newest-first, narrowed by the filters and search),
  // the filter dropdown options, the echoed search text and — only when verify=1 was
  // posted — the integrity result.
  load(
    session: Session,
    searchParams: Record<string, string | string[] | undefined>,
  ): Promise<ActivityViewProps>;
}

// Read the first non-empty value of a GET param. A facet `<select>` posts "" for its
// "All …" option, which must NOT constrain, so an empty string reads as absent; an
// array param (a repeated key) takes its first entry.
function firstValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && value.length > 0 ? value : undefined;
}

// A string field of the decrypted payload (e.g. `summary`, `detail`), or "" when the
// field is absent or not a string.
function payloadText(payload: unknown, key: string): string {
  if (payload !== null && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

// A stored instant → an absolute, readable label. The loader takes no clock seam, so
// it shows WHEN an entry occurred rather than a relative "two minutes ago" — the DATE
// and the TIME OF DAY, so two entries on the same day read as distinct moments.
// The shared formatter below supplies the account zone (stated once on the page).

// The date inputs post a calendar day ("2026-04-20"). It is a day in the account's time zone,
// like every time on the page: `from` starts at that day's local midnight and `to` is widened
// to the END of that day so the whole day is inside the inclusive upper bound. A value that
// already carries a time of day is left exactly as given.
function dayBounds(timeZone: string) {
  return { from: (from: string) => dayStartIn(from, timeZone), to: (to: string) => dayEndIn(to, timeZone) };
}

// Outcome choices for the filter, in the page's words. Several codes read the same ("Done"),
// so a repeated label says which entries it covers rather than offering "Done" four times.
const OUTCOME_COVERS: Record<string, string> = {
  executed: "agent requests",
  saved: "your changes",
  reported: "agent details",
  ok: "checks",
  done: "other",
};
function outcomeOptions(codes: readonly string[]): { value: string; label: string }[] {
  const labels = codes.map((code) => outcomeLabel(code));
  return codes.map((code, index) => {
    const label = labels[index]!;
    const repeated = labels.filter((other) => other === label).length > 1;
    return { value: code, label: repeated ? `${label} (${OUTCOME_COVERS[code] ?? code.replace(/_/g, " ")})` : label };
  });
}

// An entry seq is a position within a person's own chain: a POSITIVE INTEGER. A
// value that is not (negative, zero, fractional, NaN, Infinity) is rejected at the
// validation boundary before it can reach `WHERE … seq = $n` as a raw cast
// (OBS-049). A note must carry some text and stay within a sane bound; a reason is
// optional but likewise bounded.
const NOTE_MAX = 4000;
// A note of only spaces says nothing, so it is refused like an empty one (interaction-02).
const disputeInputSchema = z.object({
  entrySeq: z.number().int().positive(),
  note: z.string().trim().min(1).max(NOTE_MAX),
});
// A date filter is a real ISO calendar date ("YYYY-MM-DD" — what the view's date inputs
// post) or an ISO date-time. Anything else (a hand-edited `?from=yesterday-ish`) is
// ignored rather than cast at `occurred_at >= $n`, which threw a server error (review fix
// G11, the OBS-049 class).
const filterDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
function validDate(value: string | undefined): string | undefined {
  return value !== undefined && filterDateSchema.safeParse(value).success ? value : undefined;
}

const undoInputSchema = z.object({
  entrySeq: z.number().int().positive(),
  reason: z.string().max(NOTE_MAX).optional(),
});

// The STABLE refusal reason codes a wrapper turns into plain words (`./notices`). The
// sub-services report their refusals as English sentences (one carries a position
// number), so the actions translate them into these fixed codes — a stable notice code,
// never a passed-through sentence, and no internal detail or ambient value in the result.
const DISPUTE_REFUSED = "dispute_refused";
const UNDO_REFUSED = "undo_refused";
// Each distinct undo outcome the screen words differently; anything else is UNDO_REFUSED.
const UNDO_CODES: Partial<Record<UndoRefusalStatus, string>> = {
  pending_approval: "undo_pending",
  failed: "undo_failed",
  already_undone: "undo_already",
};

export function createActivityActions(deps: ActivityActionsDeps): ActivityActions {
  const { db, disputes, undo, keyWrapper, reversalFor, serviceName } = deps;

  // A connected service's display name (its catalogue name, else its id).
  const serviceLabel = (connectorId: string): string => serviceName?.(connectorId) ?? connectorId;

  // Dispute one of the acting person's OWN entries. Validate the id + note shape at
  // the boundary first (a bad id or an empty/oversized note throws a 4xx and never
  // reaches the repo), then file scoped to the SESSION user id. The repo rejects an
  // entry the caller does not own by throwing; translate that into a reported
  // refusal so another person's entry is never disputed and nothing changes.
  async function disputeEntry(
    session: Session,
    entrySeq: number,
    note: string,
  ): Promise<DisputeResult> {
    const input = parseParams(disputeInputSchema, { entrySeq, note });
    try {
      await disputes.fileDispute({
        userId: session.userId,
        entrySeq: input.entrySeq,
        note: input.note,
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: DISPUTE_REFUSED };
    }
  }

  // Undo one of the acting person's OWN reversible entries. Validate the id +
  // reason shape at the boundary first (a bad id or an oversized reason throws a 4xx
  // and never reaches the service), then undo scoped to the SESSION user id. The
  // service already reports an entry the caller does not own — or one that declares
  // no reversal — as { ok: false }; pass that refusal through and map the recorded
  // reversal entry to its seq.
  async function undoEntry(
    session: Session,
    entrySeq: number,
    reason?: string,
  ): Promise<UndoResult> {
    const input = parseParams(undoInputSchema, { entrySeq, reason });
    const result = await undo.undo({
      userId: session.userId,
      entrySeq: input.entrySeq,
      reason: input.reason,
    });
    // The service reports distinct English reasons (a non-reversible entry, or no such
    // entry — the latter carrying a position number). Neither is a stable notice code, so
    // report a stable refusal code and let the screen say it in plain words: one each for a
    // reversal held for approval, one that failed, and an entry already undone (or with an
    // undo in progress), else the one general refusal.
    if (!result.ok) return { ok: false, reason: (result.status && UNDO_CODES[result.status]) || UNDO_REFUSED };
    return { ok: true, entry: { seq: result.entry.seq } };
  }

  // Verify the acting person's OWN activity chain, scoped to the SESSION user id
  // (bound as a parameter). Returns the whole result: a sound chain of N → intact
  // with checked = N and no broken seq; a tampered chain → the first broken seq.
  async function checkIntegrity(session: Session): Promise<IntegrityResult> {
    return runIntegrityCheck(db, session.userId);
  }

  // Map a decrypted entry to the view's row. `canUndo` is `reversalFor(tool)` — true
  // only where the entry's tool declares a reversal — so the view mounts an Undo
  // control exactly where undoEntry can act and nowhere else (never a dead control).
  // An entry whose undo stands (it holds a live undo claim) is never undoable again:
  // `canUndo` is false and `undoStatus` tells the view what to say where the button was —
  // "Undone", or "Undo waiting for your approval" linking to that request in the Inbox. A
  // stale claim (its approval declined, expired or gone) reaches here as no claim, so the
  // entry is undoable again.
  // The agent is shown by the name the person gave it (`agentNames`: their OWN agents,
  // read member-scoped), never its raw id, and an agent call is titled by its tool.
  function toEntryView(
    entry: ListedActivityEntry,
    agentNames: ReadonlyMap<string, string>,
    timeZone: string,
    state: ActivityState,
    now: Date | undefined,
  ): ActivityEntryView & { attemptId?: string; intent?: true } {
    const target = calendarReversalForEntry(entry);
    const claim = entry.undoClaim;
    const canUndo = claim === undefined && target !== undefined && reversalFor?.(entry.tool) === target.tool;
    const category = activityCategory(entry, isReadOnlyTool);
    const day = dayOf(entry.occurredAt, timeZone, now);
    return {
      seq: entry.seq,
      kind: kindLabel(entry.kind),
      title: entryTitle(entry),
      source: entry.source,
      agent: agentLabel(agentNames, entry.agentId),
      agentHref: entry.agentId === undefined ? undefined : activityHref(state, { agent: entry.agentId, via: undefined }),
      agentRole: agentRole(entry.kind),
      service: entry.connectorId === undefined ? undefined : serviceLabel(entry.connectorId),
      serviceId: entry.connectorId,
      outcome: entry.outcome === undefined ? "" : outcomeLabel(entry.outcome),
      outcomeGroup: outcomeGroup(entry.outcome),
      category,
      categoryLabel: CATEGORY_LABELS[category],
      at: formatAccountTime(entry.occurredAt, timeZone),
      dateTime: entry.occurredAt,
      time: timeOfDay(entry.occurredAt, timeZone),
      dayKey: day.key,
      dayLabel: day.label,
      permalink: `${ACTIVITY_PATH}?entry=${entry.seq}#entry-${entry.seq}`,
      ...activityEvidence(entry),
      canUndo,
      ...(claim ? { undoStatus: claim.state === "done" ? { state: "done" as const }
        : { state: "waiting" as const, approvalHref: approvalHref(claim.approvalId) } } : {}),
    };
  }

  // Turn the verified session + the view's GET params into the ActivityView's props.
  // The member scope is the SESSION user id (design §5) — never a client value — for
  // every read, so one person never sees another's entries. The DEK is resolved from
  // the session person's OWN account (the loadAgentContext idiom), so only their own
  // entries can be decrypted.
  async function load(
    session: Session,
    searchParams: Record<string, string | string[] | undefined>,
  ): Promise<ActivityViewProps> {
    if (!keyWrapper) {
      throw new Error("the activity loader requires a keyWrapper to read the person's entries");
    }
    const user = await getUserById(db, session.userId);
    if (!user) {
      throw new Error("the activity loader found no account for the session");
    }
    const dek = await keyWrapper.unwrap(user.wrappedDek);
    const timeZone = await timeZoneFor(db, session.userId, dek);
    const now = deps.clock?.now();

    // The person's whole set of facet values backs the filter dropdowns, read from the
    // plaintext metadata columns (nothing decrypted), so neither a narrowing filter nor
    // the page bound hides the other agents/services/kinds/outcomes you could switch to.
    const facets = await listActivityFacets(db, session.userId);

    // The person's OWN agents' names (member-scoped by the session user id), keyed by
    // agent id and connection id: each entry and the agent filter name the agent, while
    // the filter still posts (and narrows by) its id.
    const agentNames = await agentNamesForUser(db, session.userId);
    const filterOptions: ActivityViewProps["filterOptions"] = {
      agents: [
        ...facets.agents
          .map((id) => ({ value: id, label: agentLabel(agentNames, id) ?? id }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        { value: NONE, label: "No agent (account and Warthog)" },
      ],
      services: [
        ...facets.services
          .map((id) => ({ value: id, label: serviceLabel(id) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        { value: NONE, label: "No connected service" },
      ],
      kinds: [...facets.kinds].map((value) => ({ value, label: kindLabel(value) })).sort((a, b) => a.label.localeCompare(b.label)),
      outcomes: outcomeOptions([...facets.outcomes].sort()),
    };

    // The validated screen state: the view, the drill-down it came from, and every filter.
    // Values of the wrong shape are dropped, so nothing unvalidated is echoed or linked.
    // The applied values go back to the view (`activeFilters`) so its controls show them
    // and a second Apply keeps them (review fix G11).
    const state = readActivityState(searchParams, validDate);
    const bounds = dayBounds(timeZone);
    const filters: ActivityFilters = filtersFor(state, bounds.to, bounds.from);
    const activeFilters: NonNullable<ActivityViewProps["activeFilters"]> = {
      ...(state.agent !== undefined ? { agent: state.agent } : {}),
      ...(state.service !== undefined ? { service: state.service } : {}),
      ...(state.kind !== undefined ? { kind: state.kind } : {}),
      ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
      ...(state.from !== undefined ? { from: state.from } : {}),
      ...(state.to !== undefined ? { to: state.to } : {}),
      ...(state.type !== undefined ? { type: state.type } : {}),
    };
    const names = {
      agent: state.agent !== undefined && state.agent !== NONE ? agentLabel(agentNames, state.agent) : undefined,
      service: state.service !== undefined && state.service !== NONE ? serviceLabel(state.service) : undefined,
    };
    const applied = appliedFilters(state, names);
    const common = {
      view: state.view,
      viewLinks: viewLinks(state),
      quickLinks: quickLinks(state),
      appliedFilters: applied.filters,
      clearHref: applied.clearHref,
      breadcrumb: breadcrumb(state),
      formState: stateQuery(state),
      timeZoneNote: timeZoneNote(timeZone),
      filterOptions,
      query: state.q ?? "",
      activeFilters,
    };

    // The Check-integrity control posts verify=1; only then run the record-wide check.
    const integrity =
      firstValue(searchParams.verify) === "1" ? await checkIntegrity(session) : null;

    // The grouped views count the WHOLE filtered record in SQL (no decryption, no page
    // bound); free-text search applies only to the timeline's decrypted page.
    if (state.view !== "timeline") {
      const when = (iso: string) => {
        const day = dayOf(iso, timeZone, now);
        return `${day.label}, ${timeOfDay(iso, timeZone)}`;
      };
      const byAgent = await summariseActivity(db, session.userId, filters, "agent");
      let groups;
      if (state.view === "agents") {
        const agents = new Map((await listAgentsForUser(db, session.userId)).map((agent) => [agent.id, agent]));
        groups = agentGroups(byAgent, (id) => {
          const agent = agents.get(id);
          return {
            name: agentLabel(agentNames, id) ?? id,
            platform: agent?.platform,
            platformName: agent ? platformLabel(agent.platform) : undefined,
            disconnected: agent ? agent.status !== "connected" : undefined,
            connectedOn: agent ? formatAccountTime(agent.connectedAt, timeZone, { dateOnly: true }) : undefined,
            exists: agent !== undefined,
          };
        }, state, when);
      } else if (state.view === "types") {
        groups = typeGroups(
          await summariseActivity(db, session.userId, filters, "category"),
          byAgent,
          (id) => (id === null ? "Account and Warthog" : agentLabel(agentNames, id) ?? id),
          state,
          when,
        );
      } else {
        groups = serviceGroups(await summariseActivity(db, session.userId, filters, "service"), serviceLabel, state, when);
      }
      // An empty grouped view with nothing applied is a first run: say so, with the next step.
      const hasAgents = groups.length === 0 ? (await listAgentsForUser(db, session.userId)).length > 0 : true;
      return { ...common, entries: [], groups, countsCaption: countsCaption(state), integrity, hasAgents };
    }

    // The shared filtered read (`listActivity`, E08-S05) narrows by facet/type/date in SQL,
    // newest-first, and decrypts only the bounded page it returns. A search scans a larger
    // page, since it can only match decrypted text.
    const positive = (raw: string | string[] | undefined): number | undefined => {
      const value = firstValue(raw);
      if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : undefined;
    };
    const beforeSeq = positive(searchParams.before);
    const entrySeq = positive(searchParams.entry);
    // A permalink that can't name an entry (`?entry=abc`) is a missing entry, not the whole
    // timeline: the screen says it couldn't find it (interaction-21).
    if (firstValue(searchParams.entry) !== undefined && entrySeq === undefined) {
      return { ...common, entries: [], integrity, singleEntry: true, newestHref: activityHref(state) };
    }
    if (entrySeq) filters.seq = entrySeq;
    const pageLimit = deps.pageLimit ?? (state.q ? ACTIVITY_SEARCH_LIMIT : ACTIVITY_PAGE_LIMIT);
    const limit = Math.max(1, Math.min(4999, pageLimit));
    const narrowed = await listActivity(db, session.userId, filters, dek, { limit: limit + 1, beforeSeq });
    const page = narrowed.slice(0, limit);
    const notes = await readDisputesForEntries(db, session.userId, page.map(e => e.seq), dek);
    const allViews = page.map((entry) => ({ ...toEntryView(entry, agentNames, timeZone, state, now),
      disputes: notes.filter(note => note.entrySeq === entry.seq).map(note => ({ note: note.note, at: formatAccountTime(note.createdAt, timeZone) })),
    }));
    // Each finished change appears once (content-04): the intent record written just before
    // it ran is left out when its result is on the same page. It stays when it is the entry
    // asked for, when the Event filter asks for intent records, when it was disputed, or when
    // no result followed it (it then reads "Not confirmed"). The record itself is unchanged.
    const views = entrySeq !== undefined || state.kind === "tool_attempt"
      ? allViews
      : withoutMatchedIntents(allViews, (view) => view.disputes.length > 0);
    const needle = (state.q ?? "").toLowerCase();
    const searchable = (view: (typeof views)[number]) => [
      view.summary, view.detail, view.title, view.service, view.agent,
      ...(view.facts ?? []).map((line) => line.value),
      ...(view.technical ?? []).map((line) => line.value),
      ...view.disputes.map(n => n.note),
    ];
    const entries = (needle.length === 0 ? views : views.filter(view =>
      searchable(view).some(value => value?.toLowerCase().includes(needle))))
      .map(({ attemptId: _attemptId, intent: _intent, ...view }) => view);
    const newestHref = beforeSeq || entrySeq ? activityHref(state) : undefined;
    const lastSeq = page.at(-1)?.seq;
    const nextHref = narrowed.length > limit && lastSeq !== undefined ? activityHref(state, { before: String(lastSeq) }) : undefined;

    // A first-run screen offers to connect an agent only when there is none yet.
    const hasAgents = entries.length === 0 && newestHref === undefined
      ? (await listAgentsForUser(db, session.userId)).length > 0
      : true;

    return {
      ...common,
      entries,
      integrity,
      nextHref,
      newestHref,
      hasAgents,
      singleEntry: entrySeq !== undefined,
      scannedCount: state.q ? page.length : undefined,
    };
  }

  return { disputeEntry, undoEntry, checkIntegrity, load };
}
