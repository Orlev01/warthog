// E12-S19 — Notification settings loader + actions (the injectable seam the thin
// `page.tsx` loader + its server-action wrappers compose).
//
// The notification settings screen is where a person sets up HOW they are reached
// (brief "Notification settings"; design §10 Notifications): register one or more
// devices for Web Push, add + verify a mobile number for the SMS fallback with a
// 6-digit code, choose whether fallback alerts also go by email and how long to wait
// before falling back, and send a test notification. This factory is the testable
// core behind those controls; the thin loader turns a verified session into
// <NotificationsView>'s props and binds these actions.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file
// may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The testable logic lives here
// (the convention's `createXActions(deps)` pattern, the same shape as the already-
// built security / inbox / connectors actions).
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5/§10):
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — never a client-supplied value. There is no userId on any
//     input, so a signed-in person can only register devices / add numbers / change
//     preferences for THEMSELVES, and can never read or verify another person's
//     number or device by its id (it resolves to no row for them — refused, never a
//     silent success).
//   • Malformed / oversized input is rejected at the validation boundary with a 4xx
//     HttpError (parseParams) BEFORE it reaches a query: a non-HTTPS / oversized push
//     endpoint, a mis-shaped number, a mis-shaped number id (never cast at
//     `WHERE id = $1`, OBS-049) or an oversized code. Every statement the underlying
//     stores issue is parameterized (INV-102), so a SQL-shaped value travels as a
//     BOUND value and cannot alter a query.
//   • The actions run purely from their INJECTED seams (db, clock, random, hmacKey,
//     keyWrapper, senders): they read no `process.env` and hold no secret (INV-103),
//     so no ambient env value can land in a result, in stored content, or in a
//     delivered message. The verification code is stored only as a keyed HMAC and
//     lives in plain text nowhere except the single SMS that delivers it (the stores
//     own that rule); the configured push sender (the dev outbox in dev, the real
//     Azure sender in prod — the page's choice via selectSenders) delivers the test
//     push, so the loop is drivable end-to-end in the running app.

import { createHash } from "node:crypto";

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import { getUserById } from "@/server/db/users";
import {
  listSubscriptions,
  registerSubscription,
  removeSubscription,
} from "@/server/db/push-subscriptions";
import {
  addMobileNumber as addMobileNumberRepo,
  verifyMobileNumber as verifyMobileNumberRepo,
  listMobileNumbers,
} from "@/server/db/mobile-numbers";
import {
  getNotificationPrefs,
  saveNotificationPrefs as saveNotificationPrefsRepo,
} from "@/server/db/notification-prefs";
import type { Session } from "@/server/auth/session";
import type { Clock } from "@/server/seams/clock";
import type { Random } from "@/server/seams/random";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Senders } from "@/server/notify/senders";
import type { Db } from "@/server/db/index";

// The injected seams — no process.env (INV-103). `keyWrapper` resolves the session
// person's own DEK (their device subscriptions are stored DEK-encrypted); `senders`
// is the CONFIGURED sender bundle — the dev outbox for every channel in dev, the real
// Azure senders in prod — so the SMS code and the test push go out through whichever
// the composition root wired.
export interface NotificationsActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly keyWrapper: KeyWrapper;
  readonly senders: Senders;
}

// A single action's result: success, or a refusal naming its reason (a wrong/expired
// code, an id that is not this person's, no device to test-push to, or an out-of-range
// delay). Never a silent success — the page maps the reason to plain-words copy.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// The data slice <NotificationsView> is mounted with (its own prop shape): the
// person's registered devices, their mobile numbers each with its verification state,
// and their two saved preferences (email fallback + delay, the brief's defaults when
// nothing is saved). READ-ONLY.
// Each device carries a plain label (when it was registered) and a one-way fingerprint of
// its push endpoint (SHA-256 hex), so the browser can mark its own row "This device"
// without the endpoint — a capability URL — ever being sent to the page.
export interface NotificationsData {
  readonly devices: ReadonlyArray<{ id: string; label?: string; fingerprint?: string }>;
  readonly numbers: ReadonlyArray<{ id: string; number: string; verified: boolean }>;
  readonly emailFallback: boolean;
  readonly fallbackDelayMinutes: number;
}

// A new push device: its push-service endpoint, the two Web Push keys, and an optional
// expirationTime (the StoredPushSubscription shape the store persists).
export interface RegisterPushDeviceInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly expiresAt?: Date | string | null;
}

// The notification-settings actions the loader + its server-action wrappers drive.
export interface NotificationsActions {
  // Turn the verified session into the view's data: ONLY the session person's own
  // devices, numbers (with verification state) and preferences (member-scoped by
  // `session.userId`, never a client value). READ-ONLY.
  load(session: Session): Promise<NotificationsData>;
  registerPushDevice(session: Session, input: RegisterPushDeviceInput): Promise<ActionResult>;
  removePushDevice(session: Session, input: { id: string }): Promise<ActionResult>;
  addMobileNumber(session: Session, input: { number: string }): Promise<ActionResult>;
  verifyMobileNumber(session: Session, input: { id: string; code: string }): Promise<ActionResult>;
  saveNotificationPrefs(
    session: Session,
    input: { emailFallback: boolean; fallbackDelayMinutes: number },
  ): Promise<ActionResult>;
  sendTestNotification(session: Session): Promise<ActionResult>;
}

// The plain-text body the test push carries. A fixed, content-free message (no personal
// detail, nothing to redact) — its only job is to prove a push reaches each device.
const TEST_PUSH_BODY = "This is a test notification from Warthog. Notifications are working.";

// A push-service endpoint must be a well-formed HTTPS URL (Web Push is HTTPS-only) and
// bounded; a non-HTTPS or mis-shaped endpoint is rejected at the boundary (web-push.ts
// enforces the same at the sender).
function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Validate the untrusted push subscription at the boundary: a bounded HTTPS endpoint
// and the two bounded browser keys. A non-HTTPS / oversized value is rejected with a
// 4xx before anything is stored.
const registerPushSchema = z.object({
  endpoint: z.string().min(1).max(2048).refine(isHttps),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
  expiresAt: z.union([z.date(), z.string(), z.null()]).optional(),
});

// A mobile number: a bounded, phone-shaped string (an optional leading `+`, then
// digits / spaces / parens / hyphens). An oversized or otherwise mis-shaped value
// (including a SQL-injection probe) is rejected at the boundary with a 4xx before it
// reaches a write.
const mobileNumberSchema = z
  .string()
  .min(5)
  .max(20)
  .regex(/^\+?[0-9 ()-]+$/);

// A number id is a well-formed uuid; a malformed value is rejected at the boundary
// (parseParams throws a 4xx) before it can reach `WHERE id = $1` as a cast (OBS-049).
const uuidSchema = z.uuid();

// A verification code is exactly six digits; an oversized / mis-shaped code is rejected
// at the boundary with a 4xx, while a well-formed but wrong code is a domain refusal.
const codeSchema = z.string().regex(/^\d{6}$/);

// A device's plain label: the day and time it was registered (Australian English, in the
// AEST/AEDT zone the product serves), e.g. "Registered 15 Nov 2026, 11:00 pm".
function deviceLabel(createdAt: Date): string {
  const when = createdAt.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Registered ${when}`;
}

// The one-way fingerprint of a push endpoint (matches the browser's endpointFingerprint).
function endpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function createNotificationsActions(deps: NotificationsActionsDeps): NotificationsActions {
  const { db, clock, random, hmacKey, keyWrapper, senders } = deps;

  // Resolve the acting person's unwrapped DEK (their device subscriptions are stored
  // DEK-encrypted). Read the wrapped DEK member-scoped by `userId` (the session's,
  // never a client value) and unwrap it through the KeyWrapper seam. Throws when the
  // person has no row — never fails silently.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("notifications actions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Read ONLY the session person's own rows (member-scoped by `session.userId`): their
  // registered devices (decrypted under their DEK), their numbers with each one's
  // verification state, and their saved preferences (the store returns the brief's
  // defaults — email on, 2 minutes — when nothing is saved).
  async function load(session: Session): Promise<NotificationsData> {
    const dek = await dataKeyFor(session.userId);
    const subscriptions = await listSubscriptions(db, session.userId, dek, clock);
    const numbers = await listMobileNumbers(db, session.userId);
    const prefs = await getNotificationPrefs(db, session.userId);
    return {
      devices: subscriptions.map((subscription) => ({
        id: subscription.id,
        label: deviceLabel(subscription.createdAt),
        fingerprint: endpointFingerprint(subscription.endpoint),
      })),
      numbers: numbers.map((number) => ({
        id: number.id,
        number: number.number,
        verified: number.verified,
      })),
      emailFallback: prefs.emailFallback,
      fallbackDelayMinutes: prefs.fallbackDelayMinutes,
    };
  }

  // Register a Web Push device for the session person. Validate the subscription at the
  // boundary first (a 4xx on a non-HTTPS / oversized value, before any query), then
  // store it DEK-encrypted under THIS person — a person may register several, and it
  // never lands under anyone else (there is no client id to target).
  async function registerPushDevice(
    session: Session,
    input: RegisterPushDeviceInput,
  ): Promise<ActionResult> {
    const parsed = parseParams(registerPushSchema, input);
    const dek = await dataKeyFor(session.userId);
    // The browser reuses its existing subscription, so registering again from the same
    // device hands back an endpoint already stored: keep the one row (a duplicate would
    // push every approval to that device twice).
    const existing = await listSubscriptions(db, session.userId, dek, clock);
    if (existing.some((device) => device.endpoint === parsed.endpoint)) {
      return { ok: true };
    }
    await registerSubscription(
      db,
      {
        userId: session.userId,
        endpoint: parsed.endpoint,
        keys: parsed.keys,
        expiresAt: parsed.expiresAt,
      },
      dek,
      clock,
    );
    return { ok: true };
  }

  // Remove one of the session person's OWN devices (a lost phone, an old browser) so
  // approval pushes stop going to it. The id is validated at the boundary (a 4xx before
  // any query) and the delete is member-scoped: another person's id matches nothing.
  async function removePushDevice(session: Session, input: { id: string }): Promise<ActionResult> {
    const id = parseParams(uuidSchema, input.id);
    const removed = await removeSubscription(db, { userId: session.userId, id });
    return removed ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Add an UNVERIFIED mobile number for the session person. Validate the number at the
  // boundary first (a 4xx on an oversized / mis-shaped value, before any write), then
  // add it under THIS person; the store draws a 6-digit code, stores only its keyed
  // HMAC, and delivers the code in exactly one SMS through the configured sender.
  async function addMobileNumber(
    session: Session,
    input: { number: string },
  ): Promise<ActionResult> {
    const number = parseParams(mobileNumberSchema, input.number);
    await addMobileNumberRepo(
      db,
      { userId: session.userId, number },
      { clock, random, hmacKey, smsSender: senders.sms },
    );
    return { ok: true };
  }

  // Verify one of the session person's numbers. Validate the id AND the code at the
  // boundary first (both throw a 4xx before any query), then match member-scoped by the
  // session user id: a correct, unexpired code marks the number verified; a wrong /
  // expired code, or a number that is not this person's, is refused.
  async function verifyMobileNumber(
    session: Session,
    input: { id: string; code: string },
  ): Promise<ActionResult> {
    const id = parseParams(uuidSchema, input.id);
    const code = parseParams(codeSchema, input.code);
    const result = await verifyMobileNumberRepo(
      db,
      { userId: session.userId, id, code },
      { clock, hmacKey },
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  // Save the session person's fallback preferences (member-scoped by the session user
  // id). The store owns the one-source-of-truth range rule: a delay outside the
  // inclusive 1–30 range is refused and NOTHING is written (the stored value is left
  // untouched, never clamped).
  async function saveNotificationPrefs(
    session: Session,
    input: { emailFallback: boolean; fallbackDelayMinutes: number },
  ): Promise<ActionResult> {
    const result = await saveNotificationPrefsRepo(db, {
      userId: session.userId,
      emailFallback: input.emailFallback,
      fallbackDelayMinutes: input.fallbackDelayMinutes,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  // Deliver a test push to EACH of the session person's own registered devices through
  // the configured push sender (the dev outbox in dev), so a person can confirm
  // notifications work. With no registered device there is nowhere to push: nothing is
  // sent and the action reports a refusal (never a silent no-op).
  async function sendTestNotification(session: Session): Promise<ActionResult> {
    const dek = await dataKeyFor(session.userId);
    const devices = await listSubscriptions(db, session.userId, dek, clock);
    if (devices.length === 0) {
      return { ok: false, reason: "no_device" };
    }
    for (const device of devices) {
      await senders.push.sendPush({ recipient: device.endpoint, body: TEST_PUSH_BODY });
    }
    return { ok: true };
  }

  return {
    load,
    registerPushDevice,
    removePushDevice,
    addMobileNumber,
    verifyMobileNumber,
    saveNotificationPrefs,
    sendTestNotification,
  };
}
