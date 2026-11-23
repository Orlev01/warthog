// How an item's journal reads to an agent (docs/adr/life-admin-journal.md): each entry labelled
// with who wrote it as this reader sees them (savedBy: you, the person, or another agent by name),
// Warthog's own change entries in words, a short summary per record (open next steps, decisions in
// force, the latest hand-over note, who is handling it, when it was last touched), and the
// hand-over block get_context carries — live items with work still open, each one deterministic
// line. Member-scoped reads through the stores; the DEK is injected.

import type { Catalogue } from "../../domain/life-admin/catalogue";
import {
  actorName,
  changeText,
  currentDecisions,
  handoverLine,
  latestHandover,
  openNextSteps,
  shortDate,
  type JournalActor,
  type JournalEntryView,
} from "../../domain/life-admin/journal";
import { phaseOf, PHASE_LABELS, type PhaseView } from "../../domain/life-admin/lifecycle";
import { recordPhases } from "../../domain/life-admin/phases";
import { storedRecordName } from "../../domain/life-admin/normalise";
import type { HandoverItem } from "../../domain/life-admin/summary";
import type { SavedByResolver } from "../agents/saved-by";
import { listAgentsForUser } from "../db/agents";
import { journalHighlights, recordsWithOpenSteps, type JournalEntry } from "../db/life-admin-journal";
import type { LifeAdminRecord } from "../db/life-admin-records";
import type { Db } from "../db/index";

export const HANDOVER_MAX = 5;

export function actorOf(entry: Pick<JournalEntry, "actorKind" | "actorAgentId" | "body">, savedBy: SavedByResolver): JournalActor {
  if (entry.actorKind === "imported") return { kind: "imported", ...(entry.body.actorName ? { name: entry.body.actorName } : {}) };
  if (entry.actorKind === "person") return { kind: "person" };
  return savedBy(entry.actorAgentId) as JournalActor;
}

export function entryView(entry: JournalEntry, savedBy: SavedByResolver): JournalEntryView {
  return {
    id: entry.id,
    at: entry.at,
    kind: entry.kind,
    by: actorOf(entry, savedBy),
    reported: entry.kind !== "change",
    ...(entry.body.text ? { text: entry.body.text } : {}),
    ...(entry.body.due ? { due: entry.body.due } : {}),
    ...(entry.refId ? { refId: entry.refId } : {}),
    ...(entry.body.change ? { change: entry.body.change } : {}),
  };
}

// One entry as list_records returns it.
export function entryForAgent(view: JournalEntryView) {
  return {
    id: view.id,
    at: view.at,
    kind: view.kind,
    by: view.by,
    reported: view.reported,
    ...(view.text ? { text: view.text } : {}),
    ...(view.due ? { due: view.due } : {}),
    ...(view.kind === "decision" && view.refId ? { replaces: view.refId } : {}),
    ...(view.kind === "next_done" && view.refId ? { closes: view.refId } : {}),
    ...(view.change ? { change: changeText(view.change, view.by) } : {}),
  };
}

export interface JournalSummary {
  readonly openNext: ReadonlyArray<{ id: string; text: string; due?: string; by: JournalActor }>;
  readonly decisions: ReadonlyArray<{ id: string; text: string; at: string; by: JournalActor }>;
  readonly handover?: { text: string; at: string; by: JournalActor };
  readonly entries: number;
  readonly lastTouched?: { at: string; by: JournalActor };
}

export function summarise(views: readonly JournalEntryView[], count: number, latest: JournalEntryView | null): JournalSummary | null {
  if (count === 0) return null;
  const handover = latestHandover(views);
  return {
    openNext: openNextSteps(views).slice(0, 3).map((entry) => ({ id: entry.id, text: entry.text ?? "", ...(entry.due ? { due: entry.due } : {}), by: entry.by })),
    decisions: currentDecisions(views).slice(0, 3).map((entry) => ({ id: entry.id, text: entry.text ?? "", at: entry.at, by: entry.by })),
    ...(handover?.text ? { handover: { text: handover.text, at: handover.at, by: handover.by } } : {}),
    entries: count,
    ...(latest ? { lastTouched: { at: latest.at, by: latest.by } } : {}),
  };
}

/** The journal summary of each record, keyed by id. */
export async function journalSummaries(
  db: Db,
  userId: string,
  records: readonly LifeAdminRecord[],
  dek: Uint8Array,
  savedBy: SavedByResolver,
): Promise<Map<string, JournalSummary>> {
  const highlights = await journalHighlights(db, userId, records.map((record) => record.id), dek);
  const out = new Map<string, JournalSummary>();
  for (const [recordId, slot] of highlights) {
    const summary = summarise(slot.entries.map((entry) => entryView(entry, savedBy)), slot.count, slot.latest ? entryView(slot.latest, savedBy) : null);
    if (summary) out.set(recordId, summary);
  }
  return out;
}

/** Who is handling a record, as this reader sees them (null when nobody, or they're gone). */
export function stewardOf(record: LifeAdminRecord, savedBy: SavedByResolver, connected: ReadonlySet<string>): JournalActor | null {
  if (!record.steward || !connected.has(record.steward.agentId)) return null;
  return savedBy(record.steward.agentId) as JournalActor;
}

/** Where an item stands, in words for a hand-over line ("renews 1 Dec, in 9 days", "Happening now"). */
export function stateWords(record: LifeAdminRecord, catalogue: Catalogue, now: Date, zone: string, known?: PhaseView): string {
  const type = catalogue.typeOfRecord(record.kind, record.type);
  const phase = known ?? phaseOf(record, type, now, zone);
  const when = phase.starts ? phase.starts.toISOString() : typeof record.dueDate === "string" ? record.dueDate.slice(0, 10) : null;
  // A finished item says how it ended ("Completed (20 Nov)", "Cancelled"), not how long ago it was due.
  if (phase.bucket === "finished") return when ? `${PHASE_LABELS[phase.phase]} (${shortDate(when, zone)})` : PHASE_LABELS[phase.phase];
  if (!when || phase.inDays === undefined) return PHASE_LABELS[phase.phase];
  const days = phase.inDays;
  const meaning = type.due?.label.toLowerCase() ?? "due";
  const relative = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : `${-days} days ago`;
  return `${meaning} ${shortDate(when, zone)}, ${relative}`;
}

/**
 * The hand-over block: this agent's visible live items with an open next step, at most
 * HANDOVER_MAX, soonest step first (overdue first), then the soonest due, then most recently
 * touched. Items the calling agent itself is handling are included too: a new conversation with
 * the same agent starts as blank as another agent does.
 */
export async function handoverItems(
  db: Db,
  userId: string,
  records: readonly LifeAdminRecord[],
  catalogue: Catalogue,
  dek: Uint8Array,
  savedBy: SavedByResolver,
  now: Date,
  zone: string,
): Promise<{ items: HandoverItem[]; more: number }> {
  // Worked out together, so a trip takes its dates from its bookings.
  const phases = recordPhases(records, catalogue, now, zone);
  const live = records.filter((record) => phases.get(record.id)?.live);
  const open = await recordsWithOpenSteps(db, userId, live.map((record) => record.id));
  const candidates = live.filter((record) => open.has(record.id));
  if (candidates.length === 0) return { items: [], more: 0 };
  const summaries = await journalSummaries(db, userId, candidates, dek, savedBy);
  const connected = new Set((await listAgentsForUser(db, userId)).filter((agent) => agent.status === "connected").map((agent) => agent.id));
  const ranked = candidates
    .map((record) => ({ record, summary: summaries.get(record.id)! }))
    .filter((item) => item.summary && item.summary.openNext.length > 0)
    .sort((a, b) => {
      const dueA = a.summary.openNext.map((step) => step.due ?? "9999").sort()[0]!;
      const dueB = b.summary.openNext.map((step) => step.due ?? "9999").sort()[0]!;
      if (dueA !== dueB) return dueA.localeCompare(dueB);
      return (b.summary.lastTouched?.at ?? "").localeCompare(a.summary.lastTouched?.at ?? "") || a.record.id.localeCompare(b.record.id);
    });
  const items = ranked.slice(0, HANDOVER_MAX).map(({ record, summary }) => {
    const type = catalogue.typeOfRecord(record.kind, record.type);
    const steward = stewardOf(record, savedBy, connected);
    const decision = summary.decisions[0];
    const next = summary.openNext[0]!;
    return {
      id: record.id,
      line: handoverLine({
        name: storedRecordName(type, record.fields, Boolean(record.type)),
        state: stateWords(record, catalogue, now, zone, phases.get(record.id)),
        decision: decision ? { id: decision.id, at: decision.at, kind: "decision", by: decision.by, reported: true, text: decision.text } : null,
        next: { id: next.id, at: now.toISOString(), kind: "next", by: next.by, reported: true, text: next.text, ...(next.due ? { due: next.due } : {}) },
        steward: steward ? (steward.kind === "you" ? "you (an earlier conversation)" : actorName(steward)) : null,
        lastTouched: summary.lastTouched ? { at: summary.lastTouched.at, by: actorName(summary.lastTouched.by) } : null,
        now,
        zone,
      }),
      steward,
    };
  });
  return { items, more: Math.max(0, ranked.length - HANDOVER_MAX) };
}
