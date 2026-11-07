// E09-S12 — Token-refresh and connector-health background jobs (design §7
// "Connector engine": "a refresh job renews OAuth tokens before expiry; failures
// mark the connection 'Reconnect needed' and notify" and "Google early access:
// connections expire 7 days after consent → reminder push 24 h before; status
// 'Reconnect needed' after").
//
// These jobs run in-process off the REAL background-jobs queue (`../db/jobs`:
// enqueue/claim/run). Each schedule function enqueues a row whose `run_at` the
// queue checks against the injected Clock (never SQL now()), so "due" is
// deterministic and testable. The handler the queue runner drives is idempotent by
// construction: a refresh FAILURE is HANDLED here (status marked + one
// notification) and never re-thrown, so the queue marks the job done and a second
// run over the same state changes nothing. A success simply returns — the
// connection stays connected.
//
// External effects are INJECTED seams (this module reads no `process.env`,
// INV-103): the provider token renewal (`refresh`, which THROWS on failure), the
// notification channel (`push`), the data seam (`db`) and the clock. The actual
// token renewal and credential re-store live behind `refresh` (production wires it
// over the catalogue entry + operator client); this module only reacts to its
// outcome, so no secret is read or emitted here.
//
// Every member-scoped read/write binds the `userId` carried in the job payload
// (set from the session when the job was scheduled), never a client value, so a
// job touches only its owner's connection (`updateConnectionStatus` filters by
// both id AND user_id). Every notification body is run through the redaction module
// before it reaches a sender (project hard rule), even though the copy is fixed —
// nothing sensitive can slip into a reconnect notice.

import { redact } from "../../domain/redaction/redact";
import { enqueue, type Job } from "../db/jobs";
import { updateConnectionStatus } from "../db/connections";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { PushSender } from "../notify/senders";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

// How far BEFORE a token's expiry the renewal is scheduled, so it runs while the
// token is still valid (renew before it lapses).
const REFRESH_LEAD_MS = 5 * MINUTE_MS;

// The job types this module owns. The handler dispatches on these; the schedule
// functions stamp them.
export const REFRESH_TYPE = "connection.refresh";
export const GOOGLE_REMINDER_TYPE = "connection.google_reminder";
export const GOOGLE_LAPSE_TYPE = "connection.google_lapse";

// Fixed, code-free notice copy (plain Australian English, no protocol jargon).
// Carries no credential, token or link that could be acted on — reconnecting
// happens inside the signed-in app.
const RECONNECT_BODY =
  "Reconnect needed. One of your connected services couldn't be renewed and has " +
  "stopped working. Open Warthog to sign in again and reconnect it.";
const REMINDER_BODY =
  "Reconnect needed soon. An early-access connection will stop working in about a " +
  "day. Open Warthog to reconnect it before it lapses.";

// The injected seam that renews one connection's provider OAuth tokens (production
// wires it over the catalogue entry + operator client); it THROWS on a refresh
// failure, which the handler turns into a needs_reconnect + a notification.
export type RefreshConnection = (target: {
  userId: string;
  connectionId: string;
}) => Promise<void>;

// The injected seams the handler runs from — this module reads no process.env.
export interface ConnectorJobDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly push: PushSender;
  readonly refresh: RefreshConnection;
}

// Every connector job carries the owning person and the connection it acts on. The
// userId is set from the session at schedule time, never from a client value.
interface ConnectionTarget {
  readonly userId: string;
  readonly connectionId: string;
}

// Read the connection target out of a job payload, failing loudly (never silently)
// if a job of ours somehow lacks it.
function connectionTarget(job: Job): ConnectionTarget {
  const payload = job.payload as { userId?: unknown; connectionId?: unknown } | null | undefined;
  const userId = payload?.userId;
  const connectionId = payload?.connectionId;
  if (typeof userId !== "string" || typeof connectionId !== "string") {
    throw new Error(`connector job ${job.id} has no connection target in its payload`);
  }
  return { userId, connectionId };
}

// Run a notification body through redaction before it reaches the push channel
// (project hard rule). The copy is fixed, so there is no released value to match;
// the card-masking and truncation rules still apply.
function scrub(body: string): string {
  return redact(body, () => false) as string;
}

// Deliver exactly one push to the owning person (the recipient is the session
// userId carried in the payload, never a client value).
async function notify(deps: ConnectorJobDeps, userId: string, body: string): Promise<void> {
  await deps.push.sendPush({ recipient: userId, body: scrub(body) });
}

// Schedule a background refresh for a connection near its token expiry, due BEFORE
// `expiresAt` so the token is renewed before it lapses. Returns the enqueued job.
export async function scheduleConnectionRefresh(
  db: Db,
  { userId, connectionId, expiresAt }: { userId: string; connectionId: string; expiresAt: Date },
): Promise<Job> {
  return enqueue(db, {
    type: REFRESH_TYPE,
    payload: { userId, connectionId },
    runAt: new Date(expiresAt.getTime() - REFRESH_LEAD_MS),
  });
}

// Schedule the Google early-access timers for a connection that lapses 7 days after
// consent: a REMINDER due 24 h before the lapse, and a LAPSE mark due at the lapse.
export async function scheduleGoogleLapse(
  db: Db,
  { userId, connectionId, connectedAt }: { userId: string; connectionId: string; connectedAt: Date },
): Promise<void> {
  const lapseAt = connectedAt.getTime() + SEVEN_DAYS_MS;
  await enqueue(db, {
    type: GOOGLE_REMINDER_TYPE,
    payload: { userId, connectionId },
    runAt: new Date(lapseAt - DAY_MS),
  });
  await enqueue(db, {
    type: GOOGLE_LAPSE_TYPE,
    payload: { userId, connectionId },
    runAt: new Date(lapseAt),
  });
}

// A due refresh job: renew the token. On SUCCESS the connection stays connected
// (nothing to do). On FAILURE the provider renewal throws — park the connection as
// needs_reconnect and tell the person once. The failure is HANDLED (not re-thrown),
// so the queue marks the job done and never retries it: a second run changes
// nothing (idempotent).
async function handleRefresh(deps: ConnectorJobDeps, target: ConnectionTarget): Promise<void> {
  try {
    await deps.refresh(target);
  } catch {
    await updateConnectionStatus(deps.db, {
      userId: target.userId,
      id: target.connectionId,
      status: "needs_reconnect",
    });
    await notify(deps, target.userId, RECONNECT_BODY);
  }
}

// A due Google reminder (24 h before the lapse): push a reminder; the connection is
// still connected and its status is untouched.
async function handleGoogleReminder(deps: ConnectorJobDeps, target: ConnectionTarget): Promise<void> {
  await notify(deps, target.userId, REMINDER_BODY);
}

// A due Google lapse (at the 7-day mark): the testing-mode connection has expired —
// mark it needs_reconnect.
async function handleGoogleLapse(deps: ConnectorJobDeps, target: ConnectionTarget): Promise<void> {
  await updateConnectionStatus(deps.db, {
    userId: target.userId,
    id: target.connectionId,
    status: "needs_reconnect",
  });
}

// The dispatcher handed to the queue runner (`run(db, clock, handler)`). It routes a
// claimed job to its handler by type; an unrecognised type fails loudly rather than
// silently doing nothing.
export function createConnectorJobHandler(deps: ConnectorJobDeps): (job: Job) => Promise<void> {
  return async (job: Job): Promise<void> => {
    switch (job.type) {
      case REFRESH_TYPE:
        return handleRefresh(deps, connectionTarget(job));
      case GOOGLE_REMINDER_TYPE:
        return handleGoogleReminder(deps, connectionTarget(job));
      case GOOGLE_LAPSE_TYPE:
        return handleGoogleLapse(deps, connectionTarget(job));
      default:
        throw new Error(`createConnectorJobHandler: unknown job type ${job.type}`);
    }
  };
}
