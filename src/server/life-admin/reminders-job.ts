// E14-S09 — the life-admin reminders job (brief §"Life admin": "reminders by
// notification before due dates (default 14 days and 1 day before, adjustable per
// record)"; constitution principle 13 — reminders are deterministic code, no AI).
// This is the TIMER that fires each record's due-date reminders exactly once, without
// leaking personal content.
//
// `runLifeAdminReminders` is what the background worker runs each sweep. At that moment
// it reads EVERY person's due, unsent reminders through the store's `listDueForReminder`
// — METADATA ONLY (it never decrypts a field, so personal content cannot leak into a
// message) — and, for each (record, offset) now due:
//   • sends ONE push to the record's OWNER through `deps.push`, carrying only a REFERENCE
//     to the record (its opaque id — the app resolves it after sign-in) and NO personal
//     content; then
//   • marks that offset sent (`markReminderSent`), so `listDueForReminder` stops returning
//     it and the reminder never fires again.
//
// The defaults (14 days and 1 day before the due date) and any per-record override live on
// the record's own reminder offsets, so this job honours whatever the store hands it — it
// applies no schedule of its own. Idempotent: a second run the same day over the same
// records sends nothing more, because every fired offset is already marked sent and drops
// out of the due set. Member scope: the owner is carried on each due reminder (taken from
// the record's own row, never a client value), so every push reaches exactly its owner.
//
// A SERVER module built purely from its INJECTED seams (db, clock, push): it reads no
// `process.env` and holds no secret (INV-103) — time comes from the injected Clock (never
// SQL now()), and the configured push channel (the dev outbox in dev, the real Web Push
// sender in prod) is wired by the composition root, not chosen here. The store's queries
// BIND every value — the clock instant on the read, the record id on the sent-marker write
// (INV-102) — so a record carrying a SQL-injection-shaped value is swept as data and cannot
// alter a query.

import { listDueForReminder, markReminderSent } from "../db/life-admin-records";
import type { PushSender } from "../notify/senders";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

// The injected seams — no process.env (INV-103).
export interface LifeAdminRemindersDeps {
  // The parameterizing data seam (listDueForReminder / markReminderSent).
  readonly db: Db;
  // The current instant — "due" is computed from it, never Date.now().
  readonly clock: Clock;
  // The CONFIGURED push channel (the dev outbox in dev, the real Web Push sender in
  // prod — which is wired is the composition root's job). Carries ONLY a reference.
  readonly push: PushSender;
}

// The reminder copy. Plain Australian English, no protocol jargon, and — critically — NO
// personal content: a record's detail is the person's own DEK-encrypted content, which this
// job never loads, so it cannot ride in the body.
const REMINDER_BODY =
  "You have a Warthog reminder coming up. Open Warthog and sign in to see the details.";

// The REFERENCE the push carries: the record's opaque id as an app path the person opens
// after sign-in. No personal content — just an identifier the app resolves against the
// signed-in owner's own records.
function buildReference(recordId: string): string {
  return `/life-admin/records/${recordId}`;
}

export async function runLifeAdminReminders(deps: LifeAdminRemindersDeps): Promise<void> {
  const { db, clock, push } = deps;

  // Read EVERY person's due, unsent reminders — metadata only (no DEK, no decrypted field).
  // The clock instant is bound as a parameter on the read (INV-102).
  const due = await listDueForReminder(db, clock);

  for (const reminder of due) {
    // ONE push to the record's OWNER (carried on the due reminder, never a client value),
    // carrying only a reference to the record and no personal content.
    await push.sendPush({
      recipient: reminder.userId,
      body: REMINDER_BODY,
      link: buildReference(reminder.recordId),
    });

    // Mark this offset sent so it drops out of the due set — the sweep is idempotent and
    // the reminder never fires twice. The record id is bound as a parameter (INV-102).
    await markReminderSent(db, { recordId: reminder.recordId, offset: reminder.offset });
  }
}
