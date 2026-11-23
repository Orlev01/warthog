// Reading a life-admin item's journal (docs/adr/life-admin-journal.md): its open next steps, the
// decisions still in force, the latest hand-over note, Warthog's own change entries in words, and
// the one-line hand-over summary any agent gets for a live item — where it stands, what was decided
// and why, what's next, who is handling it and when it was last touched (I-PASS order).
//
// Entries agents write are their reports, never Warthog's facts, and are always labelled as such;
// change entries are written by Warthog itself. Finishing an item never removes its journal.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

export const JOURNAL_KINDS = ["change", "decision", "note", "next", "next_done", "handover"] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

// Who wrote an entry, as the reader sees it (the agents' savedBy, plus imported history).
export type JournalActor =
  | { readonly kind: "you" }
  | { readonly kind: "person" }
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "imported"; readonly name?: string };

export type ChangeEvent =
  | "created" | "updated" | "proposed" | "accepted" | "declined" | "confirmed" | "dismissed_change"
  | "steward" | "task_done";

export interface FieldChange {
  readonly key: string;
  readonly label: string;
  readonly from?: string;
  readonly to?: string;
}

export interface ChangeSummary {
  readonly event: ChangeEvent;
  readonly fields?: readonly FieldChange[];
  // For a steward change: who handled it before and after (display names).
  readonly from?: string;
  readonly to?: string;
}

export interface JournalEntryView {
  readonly id: string;
  readonly at: string;
  readonly kind: JournalKind;
  readonly by: JournalActor;
  // True for anything an agent or person wrote; false for Warthog's own change entries.
  readonly reported: boolean;
  readonly text?: string;
  readonly due?: string;
  // next_done → the next step it closes; decision → the decision it replaces.
  readonly refId?: string;
  readonly change?: ChangeSummary;
}

/** The next steps nobody has marked done, oldest first. */
export function openNextSteps(entries: readonly JournalEntryView[]): JournalEntryView[] {
  const done = new Set(entries.filter((entry) => entry.kind === "next_done" && entry.refId).map((entry) => entry.refId!));
  return entries.filter((entry) => entry.kind === "next" && !done.has(entry.id)).sort((a, b) => a.at.localeCompare(b.at));
}

/** The decisions no later decision replaces, newest first. */
export function currentDecisions(entries: readonly JournalEntryView[]): JournalEntryView[] {
  const replaced = new Set(entries.filter((entry) => entry.kind === "decision" && entry.refId).map((entry) => entry.refId!));
  // Newest first; entries written in the same instant keep the order they were written in.
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "decision" && !replaced.has(entry.id))
    .sort((a, b) => b.entry.at.localeCompare(a.entry.at) || b.index - a.index)
    .map(({ entry }) => entry);
}

export function latestHandover(entries: readonly JournalEntryView[]): JournalEntryView | null {
  const handovers = entries.filter((entry) => entry.kind === "handover");
  return handovers.reduce<JournalEntryView | null>((latest, entry) => (!latest || entry.at >= latest.at ? entry : latest), null);
}

/** An actor in words: "you", "the person", the agent's name. */
export function actorName(actor: JournalActor): string {
  switch (actor.kind) {
    case "you": return "you";
    case "person": return "the person";
    case "agent": return actor.name;
    case "imported": return actor.name ? `${actor.name} (imported)` : "imported history";
  }
}

const cutTo = (text: string, max: number) => {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
};

/** A Warthog change entry in words ("Instinct changed premium 1100 → 1250 and renewal date"). */
export function changeText(change: ChangeSummary, by: JournalActor): string {
  const who = actorName(by);
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  const fields = (change.fields ?? []).map((field) => (field.from !== undefined || field.to !== undefined)
    ? `${field.label.toLowerCase()} ${field.from ?? "—"} → ${field.to ?? "—"}`
    : field.label.toLowerCase());
  const list = fields.length > 0 ? ` ${fields.slice(0, 4).join(", ")}${fields.length > 4 ? ` and ${fields.length - 4} more` : ""}` : "";
  switch (change.event) {
    case "created": return `${Who} added this`;
    case "updated": return `${Who} changed${list || " it"}`;
    case "proposed": return `${Who} suggested a change:${list || " details"}`;
    case "accepted": return `${Who} accepted a suggested change`;
    case "declined": return `${Who} kept their own values`;
    case "confirmed": return `${Who} confirmed this`;
    case "dismissed_change": return `${Who} declined a suggested change`;
    case "task_done": return `${Who} finished a linked task`;
    case "steward":
      if (change.from && change.to) return `${change.to} took over from ${change.from}`;
      if (change.to) return `${change.to} is handling this`;
      return `${Who} cleared who is handling this`;
  }
}

/** "3 Dec" in a zone. */
export function shortDate(iso: string, zone: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : zone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
  }
}

export interface HandoverInput {
  readonly name: string;
  // Where it stands, in words ("renews 1 Dec, in 9 days", "Happening now", "Open").
  readonly state: string;
  readonly decision: JournalEntryView | null;
  readonly next: JournalEntryView | null;
  readonly steward: string | null;
  readonly lastTouched: { readonly at: string; readonly by: string } | null;
  readonly now: Date;
  readonly zone: string;
}

/** The one-line hand-over summary an agent gets for a live item (deterministic, never a model's words). */
export function handoverLine(input: HandoverInput): string {
  const parts = [cutTo(input.name, 60), input.state];
  if (input.decision?.text) parts.push(`decided: ${cutTo(input.decision.text, 90)} (${actorName(input.decision.by)}, ${shortDate(input.decision.at, input.zone)})`);
  if (input.next?.text) parts.push(`next: ${cutTo(input.next.text, 80)}${input.next.due ? `, due ${shortDate(input.next.due, input.zone)}` : ""}`);
  parts.push(`handled by ${input.steward ?? "no one"}`);
  if (input.lastTouched) {
    const days = Math.max(0, Math.floor((input.now.getTime() - new Date(input.lastTouched.at).getTime()) / 86_400_000));
    parts.push(`last touched ${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`} by ${input.lastTouched.by}`);
  }
  return parts.join(" · ");
}
