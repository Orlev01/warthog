// E14-S09 — the life-admin reminders job (brief §"Life admin": "reminders by
// notification before due dates (default 14 days and 1 day before, adjustable per
// record)"; constitution principle 13 — reminders are deterministic code, no AI).
// This is the TIMER that sends each record's due-date reminders without
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
//     it on later sweeps for this due date (moving the due date
//     clears the markers, so the next cycle's reminders fire).
//
// The defaults (14 days and 1 day before the due date) and any per-record override live on
// the record's own reminder offsets, so this job honours whatever the store hands it — it
// applies no schedule of its own. After a successful sweep, a sequential run over the same
// records sends nothing more, because every completed offset is already marked sent and drops
// out of the due set. Member scope: the owner is carried on each due reminder (taken from
// the record's own row, never a client value), so every push reaches exactly its owner.
// A crash after delivery but before marking, or overlapping sweeps, can repeat a push:
// the external notification and database completion are not one atomic transaction.
//
// A SERVER module built purely from its INJECTED seams (db, clock, push): it reads no
// `process.env` and holds no secret (INV-103) — time comes from the injected Clock (never
// SQL now()), and the configured push channel (the dev outbox in dev, the real Web Push
// sender in prod) is wired by the composition root, not chosen here. The store's queries
// BIND every value — the clock instant on the read, the record id on the sent-marker write
// (INV-102) — so a record carrying a SQL-injection-shaped value is swept as data and cannot
// alter a query.

import { listDueForReminder, markReminderSent, type DueReminder, type RecordKind } from "../db/life-admin-records";
import { NoPushDeviceError, type PushSender } from "../notify/senders";
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
const remindersBody = (count: number) =>
  `You have ${count} Warthog reminders coming up. Open Warthog and sign in to see the details.`;

// The REFERENCE the push carries: the record's opaque id as an app path the person opens
// after sign-in. No personal content — just an identifier the app resolves against the
// signed-in owner's own records. Typed records (`item`) open through the renewals tab, one of
// the three every installed service worker accepts (public/sw.js); the page shows any record
// by its anchor whichever record tab is named.
function buildReference(recordId: string, kind: RecordKind): string {
  const tabs: Record<RecordKind, string> = {
    subscription: "subscriptions",
    receipt_warranty: "receipts",
    renewal_appointment: "renewals",
    item: "renewals",
  };
  return `/life-admin?view=life&tab=${tabs[kind]}#record-${encodeURIComponent(recordId)}`;
}

// The sweep's due reminders, one push per person: a record with several offsets due at once
// (saved close to its date) reminds once, and a person with several records due gets one push
// naming how many, linked to the soonest. Every offset is still marked, so none comes back.
function byPerson(due: readonly DueReminder[]): DueReminder[][] {
  const groups = new Map<string, DueReminder[]>();
  for (const reminder of due) {
    const group = groups.get(reminder.userId) ?? [];
    group.push(reminder);
    groups.set(reminder.userId, group);
  }
  return [...groups.values()];
}

export async function runLifeAdminReminders(deps: LifeAdminRemindersDeps): Promise<void> {
  const { db, clock, push } = deps;

  // Read EVERY person's due, unsent reminders — metadata only (no DEK, no decrypted field).
  // The clock instant is bound as a parameter on the read (INV-102).
  const due = await listDueForReminder(db, clock);

  // One person whose push cannot be delivered (an expired push subscription, a provider blip)
  // must not stop the others: each is tried on its own, a failed one stays unmarked so the
  // next sweep tries it again, and the failures are reported together at the end. A person
  // with no device at all has nothing to retry, so their reminders are marked handled.
  const failures: unknown[] = [];
  for (const reminders of byPerson(due)) {
    const first = reminders[0]!;
    const records = new Set(reminders.map((reminder) => reminder.recordId));
    try {
      try {
        // ONE push to the record's OWNER (carried on the due reminder, never a client
        // value), carrying only a reference to the record and no personal content.
        await push.sendPush({
          recipient: first.userId,
          body: records.size > 1 ? remindersBody(records.size) : REMINDER_BODY,
          link: buildReference(first.recordId, first.kind),
        });
      } catch (error) {
        if (!(error instanceof NoPushDeviceError)) throw error;
      }

      // Mark only the captured owner/date/offset; an edit during delivery must not
      // suppress the new reminder cycle. Every value is bound as a parameter (INV-102).
      for (const reminder of reminders) await markReminderSent(db, reminder);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `life-admin-reminders: ${failures.length} reminder(s) failed to send`);
  }
}
