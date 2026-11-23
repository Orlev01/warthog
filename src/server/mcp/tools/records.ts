// E14-S08 — the `list_records` / `save_record` / `update_record` core tools
// (design §6.2 MCP core tools; brief "Life admin": records that agents and the
// person both maintain; "agents add and update records through Warthog";
// constitution principle 14 "Warthog … SHALL record every tool call itself at the
// moment it handles it"). Typed records: docs/adr/life-admin-profile.md.
//
// Records are typed by `src/domain/life-admin/record-types.ts` — vehicles and their rego,
// insurance and servicing; home; utilities; health insurance; super; ID-document expiry
// dates; work; subscriptions; pets; receipts — so any agent can answer "when does my rego
// expire?" from what an earlier agent found in email, without searching again.
//
// `list_records` hands the agent the person's records it may READ, filtered and paged, each
// labelled with its type, what its due date means, who saved it (savedBy), whether the
// person has checked it, and where an agent said it found it. `save_record` saves one record
// or a batch (an email scan) through the record service: a record matching one already saved
// updates it, an agent's record is a suggestion until the person confirms it, and an agent's
// change to a record the person confirmed waits for them. `update_record` changes one record
// by id (a patch, or the older full replace). Values that must never be kept (tax file
// numbers, passwords, government ID numbers, BSB and account numbers) are refused in the INPUT
// SCHEMA, so a refused call is recorded without its parameters and the value never reaches the
// activity record. Older callers that pass one of the three original `kind`s keep working.
//
// A SERVER module built purely from its INJECTED seams (db, the KeyWrapper that unwraps the
// person's DEK, the clock): it reads no `process.env` and holds no secret (INV-103). Each
// handler VALIDATES its input at the boundary (zod → a 4xx `HttpError` BEFORE any db access,
// INV-102). The OWNING person and the agent are ALWAYS taken from the session `connection`,
// never a value in the input. The tool call itself is recorded by the pipeline (principle 14).

import { z } from "zod";
import { recordDueDateSchema } from "../../../domain/life-admin/record-metadata";
import {
  CATEGORY_IDS,
  LEGACY_KIND_TYPES,
  MONTHS_PER_CYCLE,
  RECORD_TYPE_IDS,
  recordType,
  typeFieldLabel,
  type Cycle,
  type RecordTypeDef,
} from "../../../domain/life-admin/record-types";
import { findForbidden, findingMessage, siteName } from "../../../domain/life-admin/identifiers";
import { calendarDate, storedRecordName } from "../../../domain/life-admin/normalise";

import { parseParams } from "../../http/validate";
import { getConnectionPermissions, type ConnectionPermissions } from "../../db/agent-permissions";
import {
  createRecord,
  getRecordForUser,
  listRecordsForUser,
  type LifeAdminRecord,
  type RecordFoundIn,
  type RecordKind,
  type RecordSource,
} from "../../db/life-admin-records";
import { activeReadExposure } from "../../db/read-exposures";
import { getUserById } from "../../db/users";
import { savedByResolver, type SavedBy, type SavedByResolver } from "../../agents/saved-by";
import { changeRecord, recordStatusOf, RECORD_STATUSES, saveTypedRecord, typeOf } from "../../life-admin/record-service";
import { timeZoneFor } from "../../spending/time-zone";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import { systemClock, type Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

// Field caps, so a grossly oversized value is refused at the boundary before any db access
// (INV-102).
const MAX_STATUS = 200;
const MAX_ID = 200;
const MAX_FIELDS_CHARS = 100_000;
const MAX_REASON = 2000;
export const MAX_BATCH = 25;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// The three original record kinds, still accepted for older callers.
const RECORD_KINDS = ["subscription", "receipt_warranty", "renewal_appointment"] as const;

// The status a save with no explicit status lands at.
const DEFAULT_STATUS = "active";

// Statuses `list_records` leaves out unless asked for everything.
const ENDED = new Set(["cancelled", "canceled", "done", "expired", "ended", "paused"]);

const reason = z.string().max(MAX_REASON).optional();

const fields = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_FIELDS_CHARS, "The fields are too large.");

const typeId = z
  .string()
  .max(80)
  .refine((value) => RECORD_TYPE_IDS.includes(value), "Unknown record type. The \"Life admin records\" skill lists them (get_skill).")
  .describe('The record type, as category.type: for example "vehicle.registration", "vehicle.insurance", "health.insurance", "money.super", "utility.energy", "subscription.service" or "id.passport". The "Life admin records" skill lists every type and its fields.');

const source = z
  .object({
    service: z.string().min(1).max(60).describe('Where you found it: "gmail", "outlook", "drive", "notion", or "person" when the person told you.'),
    messageId: z.string().max(200).optional().describe("The email's message id (or the document's id)."),
    date: z.string().max(40).optional().describe("The date on the email or document, YYYY-MM-DD."),
    sender: z.string().max(200).optional().describe("Who sent it: the address or domain, e.g. service.nsw.gov.au."),
  })
  .optional()
  .describe("Where you found these details. Leave out when the person told you directly.");

// One record as save_record takes it.
const recordInput = z.object({
  type: typeId.optional(),
  kind: z.enum(RECORD_KINDS).optional().describe("Older form of type (subscription, receipt_warranty or renewal_appointment); use type."),
  fields: fields.describe("The type's fields by name, e.g. {\"provider\": \"AAMI\", \"reference\": \"MPA-2045\", \"amount\": \"1250.50\", \"currency\": \"AUD\", \"cycle\": \"yearly\"}. Unknown names are kept as extra details."),
  dueDate: recordDueDateSchema.nullable().optional().describe("The date this needs attention, YYYY-MM-DD: when it expires, renews, ends or is due. Reminders follow it."),
  status: z.string().max(MAX_STATUS).optional().describe(`One of ${RECORD_STATUSES.join(", ")}. Defaults to active.`),
  parentId: z.string().max(MAX_ID).optional().describe("The id of the person's saved vehicle, home or pet this belongs to."),
  ref: z.string().max(40).optional().describe("A short name for this record within this call, so another record in records can name it as parentRef."),
  parentRef: z.string().max(40).optional().describe("The ref of a vehicle, home or pet saved earlier in this same call."),
  source,
  onMatch: z.enum(["update", "skip", "create"]).optional().describe('When a record with the same identity is already saved: "update" it (default), "skip" it, or "create" another.'),
});
type RecordInput = z.infer<typeof recordInput>;

// The identifiers a record must never hold are refused here, at the schema, so a refused
// call is recorded without its parameters. The message names the field and rule, never the value.
function refuseForbidden(input: RecordInput, path: (string | number)[], ctx: z.RefinementCtx): void {
  const typeIdOf = input.type ?? (input.kind ? LEGACY_KIND_TYPES[input.kind] : null);
  for (const finding of findForbidden(input.fields ?? {}, typeIdOf)) {
    ctx.addIssue({ code: "custom", path: [...path, "fields", finding.field], message: findingMessage(finding) });
  }
}

function needsTypeOrKind(input: Partial<RecordInput>, path: (string | number)[], ctx: z.RefinementCtx): void {
  if (!input.type && !input.kind) ctx.addIssue({ code: "custom", path: [...path, "type"], message: "Give the record's type, e.g. \"vehicle.registration\"." });
  if (input.type && input.kind) ctx.addIssue({ code: "custom", path: [...path, "kind"], message: "Give type or kind, not both." });
}

export const listRecordsSchema = z.object({
  category: z.enum(CATEGORY_IDS).optional().describe("Only one category. Rego, car insurance and servicing are vehicle; passport or licence expiry is id; a super fund is money; electricity, internet and phone are utility."),
  type: z.string().max(80).optional().describe('Only one record type, e.g. "vehicle.registration" or "health.insurance". "*.insurance" finds every kind of insurance policy.'),
  query: z.string().max(200).optional().describe('Words to find in names and details, e.g. "motorcycle", "Bupa" or "CB500X".'),
  dueWithinDays: z.number().int().min(0).max(3650).optional().describe("Only records due within this many days, overdue ones included."),
  parentId: z.string().max(MAX_ID).optional().describe("Only the records belonging to this vehicle, home or pet."),
  include: z.enum(["current", "all"]).optional().describe('"current" (default) leaves out cancelled, expired, done and paused records.'),
  cursor: z.string().max(256).optional().describe("nextCursor from the previous page."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  reason,
});

export const saveRecordSchema = recordInput
  .partial()
  .extend({
    records: z.array(recordInput).min(1).max(MAX_BATCH).optional().describe(`Up to ${MAX_BATCH} records saved together, for example everything one email scan found. A vehicle and its rego can be saved together using ref and parentRef.`),
    reason,
  })
  .superRefine((input, ctx) => {
    if (input.records) {
      if (input.fields || input.type || input.kind) ctx.addIssue({ code: "custom", path: ["records"], message: "Give records, or one record's type and fields, not both." });
      input.records.forEach((record, index) => {
        needsTypeOrKind(record, ["records", index], ctx);
        refuseForbidden(record, ["records", index], ctx);
      });
      return;
    }
    if (!input.fields) ctx.addIssue({ code: "custom", path: ["fields"], message: "Give the record's fields." });
    needsTypeOrKind(input, [], ctx);
    refuseForbidden(input as RecordInput, [], ctx);
  });

export const updateRecordSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID),
    set: fields.optional().describe("Fields to change or add; a field set to null is removed. Leaves every other field as it is."),
    fields: fields.optional().describe("Every field, replacing all of them (the older form; prefer set)."),
    dueDate: recordDueDateSchema.nullable().optional(),
    status: z.string().max(MAX_STATUS).optional(),
    parentId: z.string().max(MAX_ID).nullable().optional().describe("Link to the person's vehicle, home or pet by id; null unlinks it."),
    type: typeId.optional().describe("Give an older record its type, e.g. \"vehicle.registration\"."),
    source,
    reason,
  })
  .superRefine((input, ctx) => {
    if (input.set && input.fields) ctx.addIssue({ code: "custom", path: ["set"], message: "Give set or fields, not both." });
    if (!input.set && !input.fields && input.dueDate === undefined && input.status === undefined && input.parentId === undefined && !input.type) {
      ctx.addIssue({ code: "custom", path: ["set"], message: "Nothing to change: give set (the fields to change), dueDate, status, parentId or type." });
    }
    for (const [key, map] of [["set", input.set], ["fields", input.fields]] as const) {
      if (!map) continue;
      const present = Object.fromEntries(Object.entries(map).filter(([, value]) => value !== null));
      for (const finding of findForbidden(present, input.type ?? null)) ctx.addIssue({ code: "custom", path: [key, finding.field], message: findingMessage(finding) });
    }
  });

// The injected seams — no process.env (INV-103).
export interface RecordsToolDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock?: Clock;
}

// What a record's due date means, as an agent should say it.
export interface RecordDue {
  readonly date: string;
  readonly means: string;
  readonly label: string;
  readonly inDays: number;
}

// One record as handed to the agent: labelled, with who saved it and whether the person has
// checked it. The owning userId and the reminder bookkeeping stay out of the result.
export interface RecordView {
  readonly id: string;
  readonly type: string;
  readonly typeLabel: string;
  readonly category: string;
  readonly name: string;
  readonly kind: RecordKind;
  readonly fields: Record<string, unknown>;
  readonly labels: Record<string, string>;
  readonly dueDate: string | Date | null;
  readonly due: RecordDue | null;
  readonly status: string;
  readonly source: RecordSource;
  readonly savedBy: SavedBy;
  readonly checkedByPerson: boolean;
  readonly changePending: boolean;
  readonly foundIn: { service: string; sender?: string; date?: string; readThroughWarthog: boolean } | null;
  readonly parentId: string | null;
  readonly updatedAt: string;
}

export type ListRecordsResult =
  | {
      status: "ok";
      today: string;
      records: ReadonlyArray<RecordView>;
      nextCursor: string | null;
      monthlyCost?: ReadonlyArray<{ currency: string; amount: number; records: number }>;
      note: string;
    }
  | { status: "refused"; reason: string };

export interface SaveResultItem {
  readonly index: number;
  readonly ref?: string;
  readonly action: "created" | "updated" | "unchanged" | "proposed" | "skipped";
  readonly id?: string;
  readonly type?: string;
  readonly name?: string;
  readonly message?: string;
  readonly problems?: readonly string[];
}

export type SaveRecordResult =
  | { status: "saved"; id: string; action: SaveResultItem["action"]; type: string; problems?: readonly string[]; message?: string }
  | { status: "proposed" | "skipped"; id?: string; action: SaveResultItem["action"]; type: string; message: string; problems?: readonly string[] }
  | { status: "ok"; results: readonly SaveResultItem[]; note: string }
  | { status: "refused"; reason: string };

export type UpdateRecordResult =
  | { status: "updated" | "unchanged"; id: string; problems?: readonly string[] }
  | { status: "proposed"; id: string; message: string; problems?: readonly string[] }
  | { status: "refused"; reason: string };

export interface ListRecordsTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<ListRecordsResult>;
}

export interface SaveRecordTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<SaveRecordResult>;
}

export interface UpdateRecordTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<UpdateRecordResult>;
}

const NO_PERMISSION_REASON = "This agent does not have permission to use records.";
const NO_SUCH_RECORD_REASON = "No such record for this person.";
const PROPOSED_MESSAGE = "The person has checked this record, so your change waits for them to accept it in Life admin. Tell them what you found.";
const SUGGESTED_NOTE = "Records you save are suggestions until the person confirms them in Life admin. Tell them what you saved.";
const LIST_NOTE = "checkedByPerson false means an agent saved it and the person hasn't confirmed it: say where it came from (\"according to an email from …\") rather than stating it as fact. Never pay, cancel or send anything on the strength of a record alone.";

async function dataKeyFor(db: Db, keyWrapper: KeyWrapper, userId: string): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("records tool: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// The connection's records permission, or null when it has none (review fix A2: its own
// `recordsAccess` grant; `recordsWrite: false` makes it read-only).
async function recordsPermission(
  db: Db,
  connection: AgentConnection,
  kind: "read" | "change",
): Promise<ConnectionPermissions | null> {
  const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
  if (!permissions || !permissions.recordsAccess || (kind === "change" && permissions.resourceControls?.recordsWrite === false)) return null;
  return permissions;
}

// Whether this agent may see a record: every record, or only the chosen ones plus those it
// saved itself.
export function visibleTo(permissions: ConnectionPermissions, agentId: string): (record: LifeAdminRecord) => boolean {
  const chosen = permissions.resourceControls?.recordIds;
  return (record) => chosen == null || chosen.includes(record.id) || (record.source.kind === "agent" && record.source.agentId === agentId);
}

// The person's local date (YYYY-MM-DD in their account time zone).
export async function todayFor(db: Db, userId: string, dek: Uint8Array, clock: Clock): Promise<string> {
  const zone = await timeZoneFor(db, userId, dek).catch(() => "UTC");
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(clock.now());
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function toView(record: LifeAdminRecord, today: string, savedBy: SavedByResolver): RecordView {
  const type = typeOf(record);
  const date = dateOnly(record.dueDate);
  const labels: Record<string, string> = {};
  for (const key of Object.keys(record.fields)) {
    const label = typeFieldLabel(type, key);
    if (label) labels[key] = label;
  }
  return {
    id: record.id,
    type: type.id,
    typeLabel: type.label,
    category: type.category,
    name: storedRecordName(record.kind, record.type, record.fields),
    kind: record.kind,
    fields: record.fields,
    labels,
    dueDate: record.dueDate,
    due: date ? { date, means: type.due?.means ?? "due", label: type.due?.label ?? "Due", inDays: daysBetween(today, date) } : null,
    status: record.status,
    source: record.source,
    savedBy: savedBy(record.source.kind === "agent" ? record.source.agentId : null),
    checkedByPerson: record.reviewState === "confirmed",
    changePending: record.pending !== null,
    foundIn: record.foundIn
      ? {
          service: record.foundIn.service,
          ...(record.foundIn.sender ? { sender: record.foundIn.sender } : {}),
          ...(record.foundIn.date ? { date: record.foundIn.date } : {}),
          readThroughWarthog: record.foundIn.seenByWarthog,
        }
      : null,
    parentId: record.parentId,
    updatedAt: record.updatedAt,
  };
}

function typeMatches(pattern: string, type: RecordTypeDef): boolean {
  if (pattern.startsWith("*.")) return type.id.endsWith(pattern.slice(1));
  if (!pattern.includes(".")) return type.category === pattern;
  return type.id === pattern;
}

function searchable(record: LifeAdminRecord, type: RecordTypeDef): string {
  const values = Object.values(record.fields).filter((value) => typeof value === "string" || typeof value === "number");
  return [type.label, type.category, ...values].join(" ").toLowerCase();
}

// Sorting and paging: soonest due first, undated last, then oldest first.
function sortKey(record: LifeAdminRecord): string {
  return `${dateOnly(record.dueDate) ?? "9999-99-99"}|${record.createdAt}|${record.id}`;
}
const cursorShape = z.object({ k: z.string().max(200) });
function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify({ k: key })).toString("base64url");
}
function decodeCursor(value: string): string | null {
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))).k;
  } catch {
    return null;
  }
}

// Recurring costs as a monthly figure, per currency, worked out here rather than by the agent.
function monthlyCost(records: readonly LifeAdminRecord[]): { currency: string; amount: number; records: number }[] {
  const totals = new Map<string, { amount: number; records: number }>();
  for (const record of records) {
    const amount = Number(record.fields.amount);
    const cycle = record.fields.cycle as Cycle | undefined;
    if (!Number.isFinite(amount) || !cycle || cycle === "one_off" || !(cycle in MONTHS_PER_CYCLE)) continue;
    const currency = typeof record.fields.currency === "string" && record.fields.currency ? record.fields.currency : "AUD";
    const total = totals.get(currency) ?? { amount: 0, records: 0 };
    total.amount += amount / MONTHS_PER_CYCLE[cycle as Exclude<Cycle, "one_off">];
    total.records += 1;
    totals.set(currency, total);
  }
  return [...totals].map(([currency, total]) => ({ currency, amount: Math.round(total.amount * 100) / 100, records: total.records }));
}

export function createListRecordsTool(deps: RecordsToolDeps): ListRecordsTool {
  const { db, keyWrapper } = deps;
  const clock = deps.clock ?? systemClock;

  return {
    name: "list_records",
    inputSchema: listRecordsSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<ListRecordsResult> {
      const parsed = parseParams(listRecordsSchema, input);
      const after = parsed.cursor ? decodeCursor(parsed.cursor) : null;
      if (parsed.cursor && after === null) return { status: "refused", reason: "Invalid page cursor. Start from the first page." };

      const permissions = await recordsPermission(db, connection, "read");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Read ONLY the CONNECTION's person's records, decrypted under the owner's DEK, then keep
      // the ones this agent may see and the filters ask for.
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const today = await todayFor(db, connection.userId, dek, clock);
      const query = parsed.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const matching = (await listRecordsForUser(db, connection.userId, dek))
        .filter(visibleTo(permissions, connection.agentId))
        .filter((record) => {
          const type = typeOf(record);
          if (parsed.category && type.category !== parsed.category) return false;
          if (parsed.type && !typeMatches(parsed.type, type)) return false;
          if (parsed.parentId && record.parentId !== parsed.parentId && record.id !== parsed.parentId) return false;
          if ((parsed.include ?? "current") === "current" && ENDED.has(record.status.toLowerCase())) return false;
          if (parsed.dueWithinDays !== undefined) {
            const date = dateOnly(record.dueDate);
            if (!date || daysBetween(today, date) > parsed.dueWithinDays) return false;
          }
          if (query.length > 0) {
            const text = searchable(record, type);
            if (!query.every((word) => text.includes(word))) return false;
          }
          return true;
        })
        .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

      const limit = parsed.limit ?? DEFAULT_LIMIT;
      const start = after === null ? 0 : matching.findIndex((record) => sortKey(record) > after);
      const page = start < 0 ? [] : matching.slice(start, start + limit);
      const more = start >= 0 && start + limit < matching.length;
      const savedBy = await savedByResolver(db, connection.userId, connection.agentId);
      const totals = monthlyCost(matching);

      return {
        status: "ok",
        today,
        records: page.map((record) => toView(record, today, savedBy)),
        nextCursor: more ? encodeCursor(sortKey(page[page.length - 1]!)) : null,
        ...(totals.length > 0 ? { monthlyCost: totals } : {}),
        note: LIST_NOTE,
      };
    },
  };
}

// Where an agent says it found a record, with Warthog's own check: did this agent just read
// mail from that sender through Warthog? (The read-exposure window keeps the last few senders.)
async function foundInFor(
  db: Db,
  connection: AgentConnection,
  dek: Uint8Array,
  clock: Clock,
  claimed: RecordInput["source"],
  exposure: { sources: readonly { service: string; sender?: string }[] } | null,
): Promise<RecordFoundIn | null> {
  if (!claimed || claimed.service.toLowerCase() === "person") return null;
  const domain = claimed.sender ? (claimed.sender.includes("@") ? claimed.sender.split("@").pop()! : siteName(claimed.sender) ?? claimed.sender).toLowerCase() : null;
  const seen = domain !== null && (exposure?.sources ?? []).some((read) => {
    const readDomain = read.sender?.split("@").pop()?.toLowerCase();
    return readDomain !== undefined && (readDomain === domain || readDomain.endsWith(`.${domain}`) || domain.endsWith(`.${readDomain}`));
  });
  const date = claimed.date ? calendarDate(claimed.date) : null;
  return {
    service: claimed.service.slice(0, 60),
    ...(claimed.messageId ? { messageId: claimed.messageId } : {}),
    ...(date ? { date } : {}),
    ...(domain ? { sender: domain.slice(0, 200) } : {}),
    seenByWarthog: seen,
  };
}

function typedStatus(raw: string | undefined, problems: string[]) {
  if (raw === undefined) return undefined;
  const status = recordStatusOf(raw);
  if (!status) problems.push(`Saved as active: status is one of ${RECORD_STATUSES.join(", ")}.`);
  return status ?? "active";
}

export function createSaveRecordTool(deps: RecordsToolDeps): SaveRecordTool {
  const { db, keyWrapper } = deps;
  const clock = deps.clock ?? systemClock;

  return {
    name: "save_record",
    inputSchema: saveRecordSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<SaveRecordResult> {
      const parsed = parseParams(saveRecordSchema, input);

      const permissions = await recordsPermission(db, connection, "change");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const actor = { kind: "agent" as const, agentId: connection.agentId };
      const canSee = visibleTo(permissions, connection.agentId);
      const exposure = await activeReadExposure(db, connection.userId, connection.agentId, clock.now(), dek).catch(() => null);
      const batch: RecordInput[] = parsed.records ?? [parsed as RecordInput];
      const refs = new Map<string, string>();
      const results: SaveResultItem[] = [];

      for (const [index, item] of batch.entries()) {
        const problems: string[] = [];
        const foundIn = await foundInFor(db, connection, dek, clock, item.source, exposure);

        // An older caller's kind: saved exactly as before (its own field names), now as a suggestion.
        if (!item.type && item.kind) {
          const record = await createRecord(db, {
            userId: connection.userId,
            kind: item.kind,
            fields: item.fields,
            dueDate: item.dueDate ?? null,
            status: item.status ?? DEFAULT_STATUS,
            source: actor,
            foundIn,
          }, dek);
          if (item.ref) refs.set(item.ref, record.id);
          results.push({ index, ...(item.ref ? { ref: item.ref } : {}), action: "created", id: record.id, type: LEGACY_KIND_TYPES[item.kind], name: storedRecordName(record.kind, null, record.fields) });
          continue;
        }

        const type = recordType(item.type!)!;
        let parentId = item.parentId;
        if (item.parentRef) {
          parentId = refs.get(item.parentRef);
          if (!parentId) problems.push(`Not linked: no record in this call has ref "${item.parentRef}".`);
        }
        if (parentId && !(await getRecordForUser(db, connection.userId, parentId, dek).then((parent) => parent && canSee(parent)))) {
          problems.push(`Not linked: no saved vehicle, home or pet "${parentId}" for this person.`);
          parentId = undefined;
        }
        const outcome = await saveTypedRecord(db, dek, connection.userId, actor, {
          type,
          fields: item.fields,
          ...(item.dueDate !== undefined ? { dueDate: item.dueDate } : {}),
          status: typedStatus(item.status, problems),
          ...(parentId !== undefined ? { parentId } : {}),
          foundIn,
          onMatch: item.onMatch,
          canSee,
        }, clock.now());
        const all = [...problems, ...outcome.problems, ...(outcome.hints ?? [])];
        if (outcome.record && item.ref) refs.set(item.ref, outcome.record.id);
        results.push({
          index,
          ...(item.ref ? { ref: item.ref } : {}),
          action: outcome.action,
          ...(outcome.record ? { id: outcome.record.id, name: storedRecordName(outcome.record.kind, outcome.record.type, outcome.record.fields) } : {}),
          type: type.id,
          ...(outcome.action === "proposed" ? { message: PROPOSED_MESSAGE } : outcome.action === "skipped" ? { message: outcome.reason } : {}),
          ...(all.length > 0 ? { problems: all } : {}),
        });
      }

      if (parsed.records) return { status: "ok", results, note: SUGGESTED_NOTE };
      const [only] = results;
      if (only!.action === "proposed" || only!.action === "skipped") {
        return { status: only!.action, ...(only!.id ? { id: only!.id } : {}), action: only!.action, type: only!.type!, message: only!.message!, ...(only!.problems ? { problems: only!.problems } : {}) };
      }
      return { status: "saved", id: only!.id!, action: only!.action, type: only!.type!, ...(only!.problems ? { problems: only!.problems } : {}), message: SUGGESTED_NOTE };
    },
  };
}

export function createUpdateRecordTool(deps: RecordsToolDeps): UpdateRecordTool {
  const { db, keyWrapper } = deps;
  const clock = deps.clock ?? systemClock;

  return {
    name: "update_record",
    inputSchema: updateRecordSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<UpdateRecordResult> {
      const parsed = parseParams(updateRecordSchema, input);

      const permissions = await recordsPermission(db, connection, "change");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Find the record THIS PERSON owns that this agent may see. A missing one refuses.
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const existing = await getRecordForUser(db, connection.userId, parsed.id, dek);
      if (!existing || !visibleTo(permissions, connection.agentId)(existing)) {
        return { status: "refused", reason: NO_SUCH_RECORD_REASON };
      }
      // A link only to a vehicle, home or pet this agent may see.
      if (parsed.parentId) {
        const parent = await getRecordForUser(db, connection.userId, parsed.parentId, dek);
        if (!parent || !visibleTo(permissions, connection.agentId)(parent)) {
          return { status: "refused", reason: "No saved vehicle, home or pet with that id for this person." };
        }
      }
      const patch = parsed.set ?? parsed.fields ?? {};
      const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null));
      const remove = Object.entries(patch).filter(([, value]) => value === null).map(([key]) => key);
      const exposure = parsed.source ? await activeReadExposure(db, connection.userId, connection.agentId, clock.now(), dek).catch(() => null) : null;
      const foundIn = parsed.source ? await foundInFor(db, connection, dek, clock, parsed.source, exposure) : undefined;
      const outcome = await changeRecord(db, dek, existing, { kind: "agent", agentId: connection.agentId }, {
        set,
        remove,
        replace: parsed.fields !== undefined,
        ...(parsed.dueDate !== undefined ? { dueDate: parsed.dueDate } : {}),
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        ...(parsed.parentId !== undefined ? { parentId: parsed.parentId } : {}),
        ...(parsed.type ? { type: recordType(parsed.type)! } : {}),
        ...(foundIn !== undefined ? { foundIn } : {}),
        // An older record changed the older way keeps its own field names.
        raw: !existing.type && !parsed.type,
      }, clock.now());

      if (outcome.action === "refused") return { status: "refused", reason: outcome.reason };
      const problems = outcome.problems.length > 0 ? { problems: outcome.problems } : {};
      if (outcome.action === "proposed") return { status: "proposed", id: existing.id, message: PROPOSED_MESSAGE, ...problems };
      return { status: outcome.action, id: existing.id, ...problems };
    },
  };
}
