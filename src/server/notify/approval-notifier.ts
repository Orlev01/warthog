// E12-S07 — the approval notifier (design §10 Notifications). The brief's NFR:
// "WHEN an approval request is created, THE SYSTEM SHALL send a push notification to
// every device the person has registered within 5 seconds" and "IF a person has no
// registered push device … THEN … send one SMS … and one email …" (the fallback,
// armed at `created_at + fallback_delay`).
//
// `notifyApprovalCreated` is what the pipeline triggers the moment it creates an
// approval (the pipeline is the single place approvals are created). It does two
// things for that approval:
//   • pushes the approval id to EVERY one of the owner's active registered devices
//     through the CONFIGURED push sender (the dev outbox adapter in dev, the real
//     VAPID Web Push sender in prod — which one is wired is the composition root's
//     job, not this module's), and
//   • schedules ONE fallback job due at created_at + the person's fallback delay, so
//     a person with no device (or whose push did not arrive) is still reached.
//
// The push carries ONLY the approval id — never any personal content: the sender's
// `(subscription, approvalId)` shape leaves no slot for detail, and this module never
// loads the approval's (personal) detail. A push send FAILURE does not derail it —
// the fallback is the recovery (web-push.ts rejects a failed send so a fallback
// channel can run), so each send is awaited independently and the fallback is
// scheduled regardless.
//
// This is a SERVER module built purely from its INJECTED seams (db, clock, push) plus
// its input: it reads no `process.env` and holds no secret (INV-103) — the one secret
// in the push path (the VAPID signing key) is read from config by the Web Push sender
// it is handed, never here. Every db read/write is member-scoped by the `userId` the
// caller passes (the session's / the agent connection's, never a client value) and
// parameter-bound through the stores (INV-102); the untrusted-shaped approval id is
// validated at the boundary (a 4xx on malformed/oversized input) before anything is
// sent or scheduled.

import { z } from "zod";

import { enqueue } from "../db/jobs";
import { getNotificationPrefs } from "../db/notification-prefs";
import { listSubscriptions } from "../db/push-subscriptions";
import { parseParams } from "../http/validate";
import type { PushDeviceSubscription } from "./web-push";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

// The fallback job's type — the agreed cross-task contract the fallback worker claims
// a due job by (read back from the `jobs` table).
export const FALLBACK_JOB_TYPE = "approval.fallback";

const MINUTE_MS = 60_000;

// The push seam the notifier depends on — one device at a time, carrying ONLY the
// approval id (never personal content). Both the real VAPID Web Push sender
// (E12-S02 `createWebPushSender`, method `sendApprovalPush`) and a dev adapter over
// the process-wide outbox satisfy it; which one is wired is the composition root's
// job (selectSenders), not this module's.
export interface ApprovalPushSender {
  sendApprovalPush(subscription: PushDeviceSubscription, approvalId: string): Promise<void>;
}

// The injected seams — no process.env (INV-103).
export interface NotifyApprovalCreatedDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly push: ApprovalPushSender;
}

export interface NotifyApprovalCreatedInput {
  // The OWNING person (member scope) — from the session / agent connection, never a
  // client value.
  readonly userId: string;
  // The just-created approval (the ONLY thing the push carries).
  readonly approvalId: string;
  // When the approval was created — the fallback is due at createdAt + the person's
  // delay (NOT clock.now()).
  readonly createdAt: Date | string;
  // The owner's data key, to decrypt their device subscriptions.
  readonly dek: Uint8Array;
}

// Validate the one untrusted-shaped field: the approval id is a non-empty, bounded
// string. A malformed (empty) or oversized id is rejected at the boundary with a 4xx
// before anything is sent or scheduled; a well-formed but injection-shaped id is
// opaque data, carried verbatim and bound as a parameter by the stores below.
const approvalIdSchema = z.string().min(1).max(256);

export async function notifyApprovalCreated(
  deps: NotifyApprovalCreatedDeps,
  input: NotifyApprovalCreatedInput,
): Promise<void> {
  const { db, clock, push } = deps;

  // Validate BEFORE anything is sent or scheduled: a 4xx on a malformed / oversized
  // id, with no push sent and no fallback scheduled.
  const approvalId = parseParams(approvalIdSchema, input.approvalId);
  const createdAt =
    input.createdAt instanceof Date ? input.createdAt : new Date(input.createdAt);

  // Push the approval id to EVERY one of the owner's active registered devices
  // (member-scoped by userId; decrypted under the owner's DEK). A send failure does
  // NOT derail the notifier — the fallback below is the recovery — so each send is
  // awaited independently and a rejection is tolerated.
  const subscriptions = await listSubscriptions(db, input.userId, input.dek, clock);
  await Promise.allSettled(
    subscriptions.map((subscription) =>
      push.sendApprovalPush({ endpoint: subscription.endpoint, keys: subscription.keys }, approvalId),
    ),
  );

  // Schedule ONE fallback job due at created_at + the person's fallback delay (the
  // notification-prefs store's default is 2 minutes when the person has saved none).
  const { fallbackDelayMinutes } = await getNotificationPrefs(db, input.userId);
  const runAt = new Date(createdAt.getTime() + fallbackDelayMinutes * MINUTE_MS);
  await enqueue(db, { type: FALLBACK_JOB_TYPE, payload: { approvalId }, runAt });
}
