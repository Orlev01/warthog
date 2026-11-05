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
import { listActivity, type ActivityFilters } from "@/server/activity/list";
import { getUserById } from "@/server/db/users";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { ActivityEntry } from "@/server/activity/recorder";
import type {
  ActivityEntryView,
  ActivityFilterOptions,
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
    { ok: true; entry: { seq: number } } | { ok: false; reason: string }
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
}

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

// A stored code → a display label (e.g. "tool_call" → "Tool call"), since the view
// shows `kind`/`outcome` to a person and the loader hands them already readable.
function humanise(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// A stored instant → an absolute, readable label. The loader takes no clock seam, so
// it shows WHEN an entry occurred rather than a relative "two minutes ago".
function formatAt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// The distinct filterable values present in the person's own entries — each is posted
// back verbatim as its filter value, so the options ARE the agent/service/kind/outcome
// the filter dropdowns match on. Built from the FULL set so a narrowing filter never
// hides the other values you could switch to.
function buildFilterOptions(entries: readonly ActivityEntry[]): ActivityFilterOptions {
  const agents = new Set<string>();
  const services = new Set<string>();
  const kinds = new Set<string>();
  const outcomes = new Set<string>();
  for (const entry of entries) {
    if (entry.agentId) agents.add(entry.agentId);
    if (entry.connectorId) services.add(entry.connectorId);
    if (entry.kind) kinds.add(entry.kind);
    if (entry.outcome) outcomes.add(entry.outcome);
  }
  return {
    agents: [...agents],
    services: [...services],
    kinds: [...kinds],
    outcomes: [...outcomes],
  };
}

// An entry seq is a position within a person's own chain: a POSITIVE INTEGER. A
// value that is not (negative, zero, fractional, NaN, Infinity) is rejected at the
// validation boundary before it can reach `WHERE … seq = $n` as a raw cast
// (OBS-049). A note must carry some text and stay within a sane bound; a reason is
// optional but likewise bounded.
const NOTE_MAX = 4000;
const disputeInputSchema = z.object({
  entrySeq: z.number().int().positive(),
  note: z.string().min(1).max(NOTE_MAX),
});
const undoInputSchema = z.object({
  entrySeq: z.number().int().positive(),
  reason: z.string().max(NOTE_MAX).optional(),
});

// The plain-words refusal shown when a well-formed dispute is for an entry that is
// not this person's (the dispute repo rejects an entry the caller does not own). A
// fixed string, so no internal detail or ambient value leaks into the result.
const DISPUTE_REFUSED = "That activity entry can't be disputed.";

export function createActivityActions(deps: ActivityActionsDeps): ActivityActions {
  const { db, disputes, undo, keyWrapper, reversalFor } = deps;

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
    if (!result.ok) return { ok: false, reason: result.reason };
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
  function toEntryView(entry: ActivityEntry): ActivityEntryView {
    const canUndo = reversalFor !== undefined && reversalFor(entry.tool) !== undefined;
    return {
      seq: entry.seq,
      kind: humanise(entry.kind),
      source: entry.source,
      agent: entry.agentId,
      service: entry.connectorId,
      outcome: entry.outcome === undefined ? "" : humanise(entry.outcome),
      at: formatAt(entry.occurredAt),
      summary: payloadText(entry.payload, "summary"),
      detail: payloadText(entry.payload, "detail"),
      canUndo,
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

    // The FULL set backs the filter dropdowns, so a narrowing filter never hides the
    // other agents/services/kinds/outcomes you could switch to.
    const all = await listActivity(db, session.userId, {}, dek);
    const filterOptions = buildFilterOptions(all);

    // The facet/date filters the view posts back: `agent`→agentId, `service`→
    // connectorId, and kind/outcome/from/to verbatim. An empty "All …" option (or an
    // absent param) does not constrain.
    const filters: ActivityFilters = {};
    const agentId = firstValue(searchParams.agent);
    if (agentId !== undefined) filters.agentId = agentId;
    const connectorId = firstValue(searchParams.service);
    if (connectorId !== undefined) filters.connectorId = connectorId;
    const kind = firstValue(searchParams.kind);
    if (kind !== undefined) filters.kind = kind;
    const outcome = firstValue(searchParams.outcome);
    if (outcome !== undefined) filters.outcome = outcome;
    const from = firstValue(searchParams.from);
    if (from !== undefined) filters.from = from;
    const to = firstValue(searchParams.to);
    if (to !== undefined) filters.to = to;

    // Reuse the full read when nothing narrows it; otherwise the shared filtered read
    // (`listActivity`, E08-S05) narrows by facet/date in SQL, newest-first.
    const narrowed =
      Object.keys(filters).length === 0
        ? all
        : await listActivity(db, session.userId, filters, dek);

    // The free-text search narrows further, in-app over the decrypted summary (an
    // encrypted column can't be matched in SQL), case-insensitively over the same text
    // the view shows.
    const views = narrowed.map(toEntryView);
    const query = firstValue(searchParams.q) ?? "";
    const needle = query.toLowerCase();
    const entries =
      needle.length === 0
        ? views
        : views.filter((view) => view.summary.toLowerCase().includes(needle));

    // The Check-integrity control posts verify=1; only then run the record-wide check.
    const integrity =
      firstValue(searchParams.verify) === "1" ? await checkIntegrity(session) : null;

    return { entries, filterOptions, query, integrity };
  }

  return { disputeEntry, undoEntry, checkIntegrity, load };
}
