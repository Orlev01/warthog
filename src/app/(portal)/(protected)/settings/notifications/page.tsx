import { SmsUnavailableError } from "../../../../../server/notify/twilio";
import { notificationSenders } from "../../../../../server/notify/production";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice as InlineNotice } from "@/components/ui/notice";

import { NotificationsView } from "@/components/settings/notifications-view";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { verifySession, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { selectSenders, type Senders, type OutgoingMessage } from "@/server/notify/senders";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import {
  createNotificationsActions,
  type ActionResult,
  type RegisterPushDeviceInput,
} from "./actions";
import type { Metadata } from "next";

// The page title (review fix G8, WCAG 2.4.2): "%s · Warthog" via the root template.
export const metadata: Metadata = { title: "Notifications" };

// E12-S19 — Notification settings page (the thin protected-page loader over the tested
// `createNotificationsActions` seam, `./actions`) wired to its controls.
//
// The loader reads the signed-in session from the host-locked `__Host-wh_session`
// cookie, turns it (via the seam's `load`) into the session person's OWN registered
// devices, their mobile numbers with each one's verification state, and their saved
// preferences (email fallback + delay, the brief's defaults when nothing is saved),
// and mounts the render-tested <NotificationsView/> WIRED to the five notification
// actions: register a push device, add + verify a number, save preferences, and send
// a test push.
//
// Wiring follows the security screen's precedent. The number / preferences / test
// controls submit a <form action={…}>: a thin `"use server"` wrapper re-derives the
// verified session (never trusting a client value), calls the seam member-scoped to
// that session person, and redirects back with a `?notice=` code this page maps to
// plain words — a refusal (a wrong code, an out-of-range delay, no device to test) or
// a boundary 4xx is shown, never swallowed (no silent failure). The register control
// needs the browser Web Push subscription ceremony (service worker + PushManager), so
// it runs client-side in the view and hands the subscription to the client-callable
// `registerPushDeviceAction`; its outcome comes back on the same `?notice=` channel.
//
// A test push is DRIVABLE end-to-end in the running app: `selectSenders` routes every
// channel to the process-wide dev outbox when dev tooling is on, so sending a test push
// lands in `/dev/outbox`; the real Azure senders are used in prod.
//
// Thin by design (the server-composition-roots addendum): per-request data (the session
// cookie, the `?notice=` search param) is read BEFORE `getServerDb()` so `next build`
// marks the page dynamic and never prerenders it or opens the database at build time;
// config is read INSIDE each handler (`loadConfig()`), never at module load; the
// database comes from the process-wide `getServerDb()`, never `createDb`, and the shared
// handle is never closed. Config and secrets flow only through `loadConfig()` (INV-103);
// the VAPID value handed to the browser is the PUBLIC key, never a secret.

const SESSION_COOKIE = "__Host-wh_session";
const SCREEN = "/settings/notifications";

// Real senders stand-in: until the Azure channel senders are built, sending through one
// rejects loudly rather than dropping the message (constitution: never fail silently).
// With dev tooling on, `selectSenders` routes every channel to the dev outbox instead.


// Build the notifications actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets the loader resolve the session person's own
// DEK to decrypt their device subscriptions; the configured senders (the dev outbox in
// dev) carry the verification SMS and the test push.
function buildActions(db: Db) {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  return createNotificationsActions({
    db,
    clock: systemClock,
    random: systemRandom,
    hmacKey: config.hmacKey,
    keyWrapper,
    senders: notificationSenders(config, db),
  });
}

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Where a finished form action sends the person: back to the screen with the success
// code, the refusal's reason, or `invalid_request` for a boundary 4xx. Anything else is
// a genuine server fault and is rethrown, never dressed up as a notice (mirrors the
// security screen's `noticeLocation`).
function noticeLocation(successCode: string, outcome: ActionResult | unknown): string {
  // A 429 is the verification-text cap (review fix F5), said in plain words.
  if (outcome instanceof SmsUnavailableError) return `${SCREEN}?notice=sms_unavailable`;
  if (outcome instanceof HttpError && outcome.status === 429) return `${SCREEN}?notice=too_many_texts`;
  if (outcome instanceof HttpError) return `${SCREEN}?notice=invalid_request`;
  if (outcome instanceof Error) throw outcome;
  const result = outcome as ActionResult;
  const code = result.ok ? successCode : result.reason;
  return `${SCREEN}?notice=${encodeURIComponent(code)}`;
}

// --- the five wired server actions (thin wrappers over the tested seam) ---------------

// Register this browser as a push device: the view runs the Web Push ceremony and hands
// the subscription here. Returns the outcome to the client (which redirects with a
// notice); a malformed subscription is refused at the boundary as a 4xx and reported as
// an invalid request rather than crashing.
async function registerPushDeviceAction(input: RegisterPushDeviceInput): Promise<ActionResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  try {
    return await buildActions(db).registerPushDevice(session, input);
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, reason: "invalid_request" };
    throw error;
  }
}

// Add a mobile number for the session person and text its 6-digit code.
async function addMobileNumberAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).addMobileNumber(session, {
      number: String(formData.get("number") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("code_sent", outcome));
}

// Verify one of the session person's numbers with the texted code.
async function verifyMobileNumberAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).verifyMobileNumber(session, {
      id: String(formData.get("id") ?? ""),
      code: String(formData.get("code") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("number_verified", outcome));
}

// Save the session person's fallback preferences. An unchecked checkbox is absent from
// the form data (email fallback off); a delay outside 1–30 is refused and nothing saved.
async function saveNotificationPrefsAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).saveNotificationPrefs(session, {
      emailFallback: formData.get("emailFallback") != null,
      smsFallback: formData.get("smsFallback") != null,
      fallbackDelayMinutes: Number(formData.get("fallbackDelayMinutes")),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("prefs_saved", outcome));
}

// Remove one of the session person's own push devices (review fix G5), so approval pushes
// stop reaching a lost phone or an old browser. The id rides in the form; the seam
// validates it and scopes the delete to the session person.
async function removePushDeviceAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).removePushDevice(session, { id: String(formData.get("id") ?? "") });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("device_removed", outcome));
}

// Send a test push to each of the session person's registered devices through the
// configured sender (the dev outbox in dev), so a person can confirm notifications work.
async function sendTestNotificationAction(_formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).sendTestNotification(session);
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("test_sent", outcome));
}

// --- the outcome notice (plain words + an icon, never colour alone) -------------------

type Notice = { tone: "done" | "problem"; text: string };

// Plain Australian English, no protocol jargon (brief design_ux.copy). Unknown codes
// render nothing, so the query string can never inject copy onto the screen.
const NOTICES: Record<string, Notice> = {
  device_registered: { tone: "done", text: "This device is set up for push notifications." },
  device_removed: { tone: "done", text: "That device won't get Warthog notifications any more." },
  code_sent: { tone: "done", text: "Your code was submitted for delivery. When it arrives, enter it below to verify your number." },
  sms_unavailable: { tone: "problem", text: "We could not send that text. Check that your country is listed below and your number includes its country code. Email and in-app approvals remain available." },
  sms_disabled: { tone: "problem", text: "SMS is currently unavailable. You can use email, push notifications and in-app approvals." },
  number_verified: { tone: "done", text: "Your mobile number is verified." },
  prefs_saved: { tone: "done", text: "Your notification settings are saved." },
  test_sent: { tone: "done", text: "Test notification sent — check your device." },
  invalid: { tone: "problem", text: "That code wasn't right. Check the code we texted you and try again." },
  expired: { tone: "problem", text: "That code has expired. Send yourself a new code and try again." },
  delay_out_of_range: {
    tone: "problem",
    text: "Nothing was saved: the fallback delay must be between 1 and 30 minutes.",
  },
  no_device: {
    tone: "problem",
    text: "Register a device first — there's nowhere to send a test notification yet.",
  },
  push_unavailable: {
    tone: "problem",
    text: "Push notifications aren't available on this device or browser.",
  },
  push_denied: {
    tone: "problem",
    text: "Notifications are turned off for Warthog in this browser. Allow them in your browser settings, then try again.",
  },
  not_found: { tone: "problem", text: "Nothing was changed: that device is no longer registered." },
  register_failed: {
    tone: "problem",
    text: "We couldn't set this device up for push notifications. Please try again.",
  },
  invalid_request: { tone: "problem", text: "Nothing was changed: that request wasn't valid. Please try again." },
  too_many_texts: {
    tone: "problem",
    text: "You've asked for several codes recently. Please wait an hour and try again.",
  },
};

function notificationsNotice(code: string | undefined): Notice | null {
  return (code !== undefined && Object.hasOwn(NOTICES, code) && NOTICES[code]) || null;
}

function NoticeBanner({ notice }: { notice: Notice }) {
  return (
    <InlineNotice tone={notice.tone === "done" ? "success" : "error"}>{notice.text}</InlineNotice>
  );
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const rawNotice = (await searchParams).notice;
  const notice = notificationsNotice(typeof rawNotice === "string" ? rawNotice : undefined);
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }

  const data = await buildActions(db).load(session);
  // The VAPID PUBLIC key the browser needs to subscribe for Web Push (a public value,
  // never a secret) — undefined when push isn't configured, in which case the register
  // control reports "not available" rather than failing silently.
  const vapidPublicKey = loadConfig().vapid.publicKey;

  return (
    <div className="wh-page wh-page--form flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Notifications</h1>
        <p className="text-sm text-fg-muted">
          Choose how Warthog lets you know about approvals and alerts.
        </p>
      </div>
      {notice ? <NoticeBanner notice={notice} /> : null}
      <NotificationsView
        {...data}
        vapidPublicKey={vapidPublicKey}
        smsCountries={Object.keys(loadConfig().messaging?.twilio.countryRoutes ?? {})}
        registerPushDevice={registerPushDeviceAction}
        removePushDeviceAction={removePushDeviceAction}
        addMobileNumberAction={addMobileNumberAction}
        verifyMobileNumberAction={verifyMobileNumberAction}
        saveNotificationPrefsAction={saveNotificationPrefsAction}
        sendTestNotificationAction={sendTestNotificationAction}
      />
    </div>
  );
}
