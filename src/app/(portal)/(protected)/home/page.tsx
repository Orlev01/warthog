import { notificationSenders } from "../../../../server/notify/production";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DashboardView } from "@/components/home/dashboard-view";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { selectSenders, type Senders } from "@/server/notify/senders";
import { HttpError } from "@/server/http/validate";
import {
  createNotificationsActions,
  type ActionResult,
  type RegisterPushDeviceInput,
} from "../settings/notifications/actions";
import { createHomeActions } from "./actions";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import {
  getRecoveryReview,
  RECOVERY_REVIEW_COOKIE,
  RECOVERY_REVIEW_WINDOW_MS,
} from "@/server/auth/recovery-review";

// E18-S08 — Home page (the thin protected-page loader).
//
// Sign-up and sign-in land here, so /home mounts the home dashboard
// (<DashboardView>, E18-S07) behind the `createHomeActions` loader, which feeds the
// view from the session person's set-up status and dashboard metrics reads. The
// page lives inside the already-guarded `(protected)` route group, whose layout
// delegates the
// admit/redirect to `requireSession`; this loader re-derives the verified session
// from the `__Host-wh_session` cookie — never a client value (design §5) — to
// scope the person's own data, and sends an absent session back to sign-in rather
// than rendering an empty screen.
//
// Thin by design: per-request data (the cookie) is read BEFORE `getServerDb()` so
// touching it marks the page dynamic and `next build` never prerenders it; the
// database comes from the process-wide `getServerDb()`, never `createDb`, and the
// shared handle is never closed. The `(protected)` layout already wraps every page
// in the app shell (PortalChrome), so the page never wraps again.

const SESSION_COOKIE = "__Host-wh_session";

// Registering a device never sends anything, so no real channel is needed here; a send
// through one rejects loudly rather than dropping a message (never fail silently).


// Register this browser as a push device from Home's install prompt (review fix W4.1):
// the same tested seam and the same discipline as Settings → Notifications — re-derive
// the verified session from the cookie (never a client value), validate the subscription
// at the boundary (a malformed one is an invalid request, never a crash) and store it
// for the session person only.
async function registerPushDeviceAction(input: RegisterPushDeviceInput): Promise<ActionResult> {
  "use server";
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }
  const config = loadConfig();
  const actions = createNotificationsActions({
    db,
    clock: systemClock,
    random: systemRandom,
    hmacKey: config.hmacKey,
    keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }),
    senders: notificationSenders(config, db),
  });
  try {
    return await actions.registerPushDevice(session, input);
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, reason: "invalid_request" };
    throw error;
  }
}

// Hide the recovery review notice on this browser (sign-in audit, founder decision 13
// November 2026). The cookie names the session account's newest recovery, read on the
// server, and is set only when that is the one the form was showing: a recovery that
// landed after the page loaded is never hidden unseen. It only hides a notice, so it
// grants nothing, and it lasts as long as the notice would have.
async function dismissRecoveryReviewAction(formData: FormData): Promise<void> {
  "use server";
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }
  const review = await getRecoveryReview(db, { userId: session.userId }, { clock: systemClock });
  if (review && formData.get("review") === review.id) {
    store.set(RECOVERY_REVIEW_COOKIE, review.id, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(RECOVERY_REVIEW_WINDOW_MS / 1000),
    });
  }
  redirect("/home");
}

export default async function HomePage() {
  // Read per-request data first so the page is dynamic (never prerendered at build).
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  const dismissedRecoveryReview = store.get(RECOVERY_REVIEW_COOKIE)?.value ?? null;
  const config = loadConfig();
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }
  // The KeyWrapper (local AES outside production, Key Vault in production) lets the
  // loader unwrap the person's DEK so the greeting and the two owner-scoped reads
  // can decrypt their own data; the clock is "now" for the set-up and metrics reads.
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const serviceName = (connectorId: string): string | undefined => getProcessCatalogue().get(connectorId)?.name;
  const view = await createHomeActions({ db, keyWrapper, clock: systemClock, serviceName }).load(session, {
    dismissedRecoveryReview,
  });
  // The install prompt's "Turn on notifications" sets this device up for push: the
  // register action above and the PUBLIC VAPID key (never a secret; undefined when push
  // isn't configured, which the prompt reports as "not available").
  return (
    <DashboardView
      {...view}
      registerPushDevice={registerPushDeviceAction}
      vapidPublicKey={config.vapid.publicKey}
      dismissRecoveryReview={dismissRecoveryReviewAction}
    />
  );
}
