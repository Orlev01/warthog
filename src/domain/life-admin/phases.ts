// Where every record stands now, together (docs/adr/life-admin-profile.md, "Lifecycle").

import type { Catalogue } from "./catalogue";
import { anchorSpan, bookingSpan, phaseOf, type PhaseView } from "./lifecycle";
import type { StoredKind } from "./record-types";

export interface PhasedRecord {
  readonly id: string;
  readonly kind: StoredKind;
  readonly type: string | null;
  readonly status: string;
  readonly state?: string | null;
  readonly dueDate: string | Date | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly parentId?: string | null;
}

// Where each record stands now (docs/adr/life-admin-profile.md, "Lifecycle"), keyed by id: its
// phase from the one lifecycle module, worked out against the person's clock and time zone, so
// the page never needs its own copy of "not live". An anchor that bookings belong to (a trip,
// or any anchor of the person's own) carries the span of those bookings: a trip — an anchor
// that is itself a booking — takes its dates from every booking that went ahead (so a past trip
// still reads as completed on its dates); any other anchor shows the span of its live bookings.
// The page and the agent tools (list_records, get_context, the hand-over) use the same
// function, so an agent never sees a past trip as upcoming. Pure: no DB, no clock of its own.
export function recordPhases(
  records: readonly PhasedRecord[],
  catalogue: Catalogue,
  now: Date,
  zone: string,
): Map<string, PhaseView> {
  const out = new Map<string, PhaseView>();
  const typeOf = (record: (typeof records)[number]) => catalogue.typeOfRecord(record.kind, record.type);
  for (const record of records) out.set(record.id, phaseOf(record, typeOf(record), now, zone));
  for (const anchor of records) {
    const type = typeOf(anchor);
    if (!type.anchor) continue;
    const spans: { start: Date; end: Date }[] = [];
    for (const child of records) {
      if (child.parentId !== anchor.id || child.id === anchor.id) continue;
      const childType = typeOf(child);
      if (childType.lifecycle !== "booking") continue;
      const phase = out.get(child.id)!;
      if (phase.phase === "cancelled" || phase.phase === "missed" || phase.phase === "lapsed") continue;
      if (type.lifecycle !== "booking" && !phase.live) continue;
      const span = bookingSpan(child, childType, zone);
      if (span) spans.push({ start: span.start, end: span.end });
    }
    const span = anchorSpan(spans);
    if (!span) continue;
    if (type.lifecycle === "booking") out.set(anchor.id, phaseOf(anchor, type, now, zone, span));
    else out.set(anchor.id, { ...out.get(anchor.id)!, starts: span.start, ends: span.end });
  }
  return out;
}
