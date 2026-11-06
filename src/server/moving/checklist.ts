// E14-S06 — Moving checklist builder (brief "Moving-house helper"; design §4.1).
//
// When the owner's postal address carries a moving-on date, Warthog turns that date into a concrete
// checklist of the places that hold the OLD address — their connected services and the subscription /
// renewal records on file — so the person and their agents can work through the move. This builder
// composes already-built seams: it reads the SESSION person's postal addresses from the identity
// store, hands them to the pure moving-address domain (`../../domain/address/moving`) to decide there
// is an upcoming move, then gathers the connections and life-admin records on file and seeds one
// checklist item per source through the idempotent moving-checklist store.
//
// Idempotent by construction: the store dedupes on (user, source kind, source reference), and each
// source's reference is its own stable id, so a second build over unchanged connections and records
// adds nothing and never resets a ticked-off item, and the person's own additions are never touched.
//
// Member-scoped: every read and every seed is filtered by `session.userId` — never a client value —
// so one person's build never reads or seeds under another. Every seam is injected (db, clock, dek):
// this module reads no `process.env` and holds no key (INV-103), and every query it drives through the
// seams binds its values rather than splicing them (INV-102). A receipt/warranty record is NOT a place
// that holds the address, so it is never seeded.

import { resolve, type Address, type MemberAddress } from "../../domain/address/moving";
import type { Session } from "../auth/session";
import { listConnectionsForUser } from "../db/connections";
import { listIdentityFields, type IdentityField } from "../db/identity-fields";
import { listRecordsForUser } from "../db/life-admin-records";
import { seedItems, type SeedItem } from "../db/moving-checklist";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

// Every seam the build depends on is injected — no process.env, no secret (INV-103).
export interface BuildMovingChecklistDeps {
  readonly db: Db; // the one db handle every read/write runs through
  readonly clock: Clock; // supplies `now` for the moving-address resolution (never SQL now())
  readonly dek: Uint8Array; // the session person's already-unwrapped data key
}

// The build reports success; the checklist it produced is read back through the store.
export interface BuildMovingChecklistResult {
  readonly ok: true;
}

// Build the session person's moving checklist. If a postal address on file carries a moving-on date
// that is still ahead (resolved through the moving-address domain against the injected clock), seed one
// item per connected service and per subscription / renewal record. With no move — no postal address,
// or none with a moving-on date — nothing is seeded. Idempotent: a re-build over unchanged sources
// changes nothing and leaves the person's own additions intact.
export async function buildMovingChecklist(
  deps: BuildMovingChecklistDeps,
  session: Session,
): Promise<BuildMovingChecklistResult> {
  const { db, clock, dek } = deps;
  const userId = session.userId;

  const fields = await listIdentityFields(db, userId, dek);
  const member = toMemberAddress(fields.filter((f) => f.kind === "postal_address"));
  if (!member) return { ok: true };

  // The domain applies the date swap: an upcoming move remains only while now is before the moving
  // date. No upcoming move resolved ⇒ there is nothing to seed.
  const resolved = resolve(member, clock.now());
  if (!resolved.upcoming) return { ok: true };

  const items = await gatherSources(db, userId, dek);
  await seedItems(db, { userId, items }, dek);
  return { ok: true };
}

// Build the member's address situation from their postal-address fields. The settled address (no
// moving-on date) is the current one; the one carrying a moving-on date is the upcoming move. Returns
// null when there is no postal address at all (so there is no move to resolve). The address value is
// opaque to the domain, so it is parsed only to satisfy the structured `Address` shape.
function toMemberAddress(postal: IdentityField[]): MemberAddress | null {
  const moving = postal.find((f) => f.movingOn != null);
  const settled = postal.find((f) => f.movingOn == null);
  const currentField = settled ?? moving;
  if (!currentField) return null; // no postal address at all ⇒ no move to resolve

  const current = parseAddress(currentField.value);
  if (moving && moving.movingOn != null) {
    return {
      own: {
        current,
        upcoming: {
          address: parseAddress(moving.value),
          movingDate: new Date(moving.movingOn as string | Date),
        },
      },
    };
  }
  return { own: { current } };
}

// Parse a stored address value into the domain's structured `Address`. The domain never inspects it,
// so a non-object value is carried verbatim rather than rejected.
function parseAddress(value: string): Address {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object") return parsed as Address;
  } catch {
    /* not JSON — carry it verbatim */
  }
  return { value };
}

// The places that hold the old address: one seed item per connected service (kind "connection") and
// per subscription ("subscription") / renewal ("renewal") record on file. A receipt/warranty record is
// NOT such a place, so it is left out. Each item's source reference is the source's own stable id, so
// the seed is idempotent and the label can change without re-seeding.
async function gatherSources(db: Db, userId: string, dek: Uint8Array): Promise<SeedItem[]> {
  const items: SeedItem[] = [];

  for (const connection of await listConnectionsForUser(db, userId)) {
    items.push({
      label: labelFor(connection.accountLabel || connection.connectorId),
      sourceKind: "connection",
      sourceReference: connection.id,
    });
  }

  for (const record of await listRecordsForUser(db, userId, dek)) {
    const sourceKind =
      record.kind === "subscription"
        ? "subscription"
        : record.kind === "renewal_appointment"
          ? "renewal"
          : null;
    if (sourceKind === null) continue; // a receipt/warranty does not hold the address
    items.push({ label: labelFor(recordName(record.fields)), sourceKind, sourceReference: record.id });
  }

  return items;
}

// The person's own name for a source, falling back to a stable placeholder so a label is never empty.
function recordName(fields: Record<string, unknown>): string {
  const name = fields.name;
  return typeof name === "string" && name.length > 0 ? name : "this record";
}

// A plain-English checklist label: a place that still holds the old address, to update.
function labelFor(source: string): string {
  return `Update your address with ${source}`;
}
