// E17-S06 — the daily integrity-check job (brief "tamper-evident record": a daily automatic
// integrity check that alerts a person ONLY IF their record breaks, and records the pass/fail
// count in operational metrics). This background job is the scheduled worker that performs
// both halves: it sweeps every account, runs the per-account integrity check (E08-S02
// `checkIntegrity`) on each, APPENDS a pass/fail count to metrics through E17-S02's guarded
// recorder, and alerts — by push AND email, never SMS — only the people whose record failed.
//
// The sweep is GLOBAL operational work, not member-scoped personal content: the accounts come
// from the account table, and each account's id is handed to `checkIntegrity` from the row,
// never from a client value. A recorded metric is structurally only a named count plus the
// short, allowlisted `outcome` label, so no identity or activity content can reach it
// (constitution principle 19); the recorder enforces that at the single write path. The
// failure alert carries a fixed, non-personal body — never the person's identity or the
// activity payload — so the message leaks nothing either (principle 14/19).
//
// Every statement is parameterized through the `Db` seam (INV-102): the sweep query takes no
// caller input, `checkIntegrity` binds the user id, and each value the recorder writes travels
// BOUND. This module reads no `process.env` and holds no secret (INV-103): it runs purely from
// its injected db + clock + senders.

import { checkIntegrity } from "./integrity";
import { recordMetricEvent } from "../metrics/record";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { Senders, OutgoingMessage } from "../notify/senders";

// What the job runs from: the parameterizing db seam (INV-102), the clock every recorded
// metric is stamped from (never Date.now()), and the configured channel bundle (only push and
// email are used — the job never sends SMS).
export interface DailyIntegrityCheckDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly senders: Senders;
}

// The pinned metric contract: ONE name, a pass/fail COUNT split by the allowlisted `outcome`
// dimension. Both rows are recorded every run (even at 0) so the time series is continuous.
const INTEGRITY_CHECK = "integrity.check";
const OUTCOME_PASS = "pass";
const OUTCOME_FAIL = "fail";

// A fixed, non-personal alert body. It names no person and carries no activity content
// (principle 19): just that the record needs attention. Review happens inside the signed-in
// app (principle 18), so no deep link built from config/env is folded in here.
const ALERT_BODY = "Your activity record failed its integrity check — open Warthog to review it.";

// Sweep every account, run its per-account integrity check, append a pass/fail count to
// metrics, and alert (push + email) each person whose record failed.
export async function runDailyIntegrityCheck(deps: DailyIntegrityCheckDeps): Promise<void> {
  const { db, clock, senders } = deps;

  // Every account, read globally (not member-scoped — the sweep covers all). Each id is taken
  // from the row and bound into `checkIntegrity`, never from a client value.
  const accounts = await db.query("SELECT id, email FROM users");

  // One account whose check errors, or whose alert cannot be delivered, must not stop the
  // sweep: every account is still checked and alerted and the counts are still recorded;
  // the failures are reported together at the end. (An account whose check errored is in
  // neither count — it was not verified either way.)
  const failures: unknown[] = [];
  let passed = 0;
  let failed = 0;
  for (const row of accounts.rows) {
    try {
      const result = await checkIntegrity(db, String(row.id));
      if (result.intact) {
        passed += 1;
      } else {
        failed += 1;
        failures.push(...(await alertFailure(senders, row.email as string)));
      }
    } catch (error) {
      failures.push(error);
    }
  }

  // Append BOTH counts every run (0 included), stamped from the injected clock, every value
  // bound through the guarded recorder.
  await recordMetricEvent(db, clock, {
    name: INTEGRITY_CHECK,
    value: passed,
    dimensions: { outcome: OUTCOME_PASS },
  });
  await recordMetricEvent(db, clock, {
    name: INTEGRITY_CHECK,
    value: failed,
    dimensions: { outcome: OUTCOME_FAIL },
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, `daily-integrity-check: ${failures.length} check or alert failure(s)`);
  }
}

// Alert one person whose record broke: ONE push AND ONE email to their address on file, with a
// fixed non-personal body and no link. No SMS is sent. Both channels are always attempted —
// a failed push never costs the email — and the failures are returned for the caller to report.
async function alertFailure(senders: Senders, recipient: string): Promise<unknown[]> {
  const message: OutgoingMessage = { recipient, body: ALERT_BODY };
  const failures: unknown[] = [];
  for (const send of [() => senders.push.sendPush(message), () => senders.email.sendEmail(message)]) {
    try {
      await send();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
