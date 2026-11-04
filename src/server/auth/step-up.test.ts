// E04-S07 — Step-up check (`src/server/auth/step-up.ts`).
//
// RED-first: the step-up module does not exist yet, so importing `./step-up`
// throws and every test here fails until the builder adds it. That absence IS the
// point of test-first — do not implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what requireStepUp RETURNS for a given session + clock),
// never the source text of the module — a later rename that preserves behaviour must
// not redden them.
//
// The contract this task defines (brief: "WHEN a sensitive action is requested … THE
// SYSTEM SHALL require a passkey or authenticator check completed within the previous
// 5 minutes"; design §5: "step-up valid 5 minutes"):
//
//   requireStepUp(session, { clock }): boolean
//     • returns true ONLY when the session's `steppedUpAt` is present AND falls within
//       the last 5 minutes of clock.now() (now − steppedUpAt ≤ 5 min).
//     • returns false when the step-up is older than 5 minutes, or absent (null).
//
// `steppedUpAt` is factor-agnostic: both the passkey check and the TOTP check record
// it through `recordStepUp` (E04-S01/S04/S05). This task only reads that timestamp and
// judges its freshness, so the tests set it directly (the pure cases) and once via the
// real `recordStepUp` (the integration case) — never caring which factor wrote it.
//
// Acceptance criteria → tests:
//   AC1 "requireStepUp passes only when a passkey or TOTP check set stepped_up_at
//        within the last 5 minutes." — a step-up 0/1/4m59s ago passes; the integration
//        case proves a step-up written by the real recordStepUp passes within 5 minutes.
//   AC2 "An older or absent step-up is rejected." — a step-up 5m01s / 6 min / 1 hour ago
//        is rejected; a session with no step-up (steppedUpAt === null) is rejected.
//
// Every db handle (integration case only) is closed in a `finally` so node:test leaves
// no open handle; the pure cases touch neither the db, the network nor Azure.
import { test } from "node:test";
import assert from "node:assert/strict";

import { requireStepUp } from "./step-up";
import { createSession, recordStepUp, type Session } from "./session";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { systemRandom } from "../seams/random";
import type { Clock } from "../seams/clock";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

// A fixed instant used as "now" for the pure cases; steppedUpAt is set relative to it.
const NOW = new Date("2026-03-01T12:00:00.000Z");

// A frozen clock reading exactly NOW, so freshness is judged deterministically with no
// wall-clock dependence.
const clock: Clock = {
  now(): Date {
    return new Date(NOW.getTime());
  },
};

// A clock whose "now" the integration case advances, so the 5-minute window is crossed
// deterministically (same shape as session.test.ts).
function mutableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// An instant `ms` before NOW — i.e. "a step-up that happened `ms` ago".
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

// A Session carrying the given step-up time and otherwise-valid fields. requireStepUp
// reads only `steppedUpAt`; the other fields are present so the Session shape is real.
function sessionSteppedUpAt(steppedUpAt: Date | null): Session {
  return {
    id: "sess-under-test",
    userId: "user-under-test",
    createdAt: ago(60 * MINUTE_MS),
    lastSeenAt: NOW,
    steppedUpAt,
  };
}

// =====================================================================================
// AC1 — a fresh step-up (within the last 5 minutes) passes.
// =====================================================================================

test("requireStepUp passes for a step-up that happened just now", () => {
  const result = requireStepUp(sessionSteppedUpAt(ago(0)), { clock });
  assert.equal(typeof result, "boolean", "requireStepUp returns a boolean");
  assert.equal(result, true, "a step-up at this instant is fresh and passes");
});

test("requireStepUp passes for a step-up 1 minute ago", () => {
  assert.equal(
    requireStepUp(sessionSteppedUpAt(ago(1 * MINUTE_MS)), { clock }),
    true,
    "a step-up a minute ago is within the 5-minute window",
  );
});

test("requireStepUp passes just inside the 5-minute window (4m59s ago)", () => {
  assert.equal(
    requireStepUp(sessionSteppedUpAt(ago(4 * MINUTE_MS + 59 * SECOND_MS)), { clock }),
    true,
    "a step-up 4m59s ago is still within the last 5 minutes",
  );
});

// =====================================================================================
// AC2 — an older or absent step-up is rejected.
// =====================================================================================

test("requireStepUp rejects a step-up just outside the 5-minute window (5m01s ago)", () => {
  assert.equal(
    requireStepUp(sessionSteppedUpAt(ago(5 * MINUTE_MS + 1 * SECOND_MS)), { clock }),
    false,
    "a step-up 5m01s ago is past the window and is rejected",
  );
});

test("requireStepUp rejects a step-up 6 minutes ago", () => {
  assert.equal(
    requireStepUp(sessionSteppedUpAt(ago(6 * MINUTE_MS)), { clock }),
    false,
    "a step-up older than 5 minutes is rejected",
  );
});

test("requireStepUp rejects a step-up an hour ago", () => {
  assert.equal(
    requireStepUp(sessionSteppedUpAt(ago(60 * MINUTE_MS)), { clock }),
    false,
    "a long-stale step-up is rejected",
  );
});

test("requireStepUp rejects a session with no step-up at all (steppedUpAt is null)", () => {
  const result = requireStepUp(sessionSteppedUpAt(null), { clock });
  assert.equal(typeof result, "boolean", "requireStepUp returns a boolean even with no step-up");
  assert.equal(result, false, "an absent step-up is rejected");
});

// =====================================================================================
// AC1 (end-to-end) — a step-up written by the real recordStepUp passes within 5 minutes
// and is rejected once it ages past the window. This grounds the freshness check in the
// exact `steppedUpAt` the passkey/TOTP verify paths produce (via recordStepUp), not just
// a hand-built timestamp.
// =====================================================================================

test("a step-up recorded by recordStepUp passes within 5 minutes, then is rejected after it", async () => {
  const c = mutableClock(new Date("2026-03-01T00:00:00.000Z"));
  const db: Db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "stepper@warthog.com.au",
      wrappedDek: Buffer.from("wrapped-dek-stepper").toString("base64"),
    });
    const created = await createSession(db, user.id, { clock: c.clock, random: systemRandom });
    assert.equal(created.session.steppedUpAt, null, "a fresh session has no step-up yet");

    // No fresh step-up on the session as created → rejected.
    assert.equal(
      requireStepUp(created.session, { clock: c.clock }),
      false,
      "a session that has never stepped up is rejected",
    );

    // The person re-authenticates (the passkey/TOTP check calls recordStepUp).
    const stepped = await recordStepUp(db, created.session.id, { clock: c.clock });
    assert.ok(stepped.steppedUpAt != null, "recordStepUp stamps the step-up time");

    // Immediately and 4 minutes later: within the 5-minute window → passes.
    assert.equal(
      requireStepUp(stepped, { clock: c.clock }),
      true,
      "a just-recorded step-up passes",
    );
    c.advance(4 * MINUTE_MS);
    assert.equal(
      requireStepUp(stepped, { clock: c.clock }),
      true,
      "a step-up recorded 4 minutes ago still passes",
    );

    // 6 minutes after the step-up: past the window → rejected.
    c.advance(2 * MINUTE_MS); // now +6 min since the step-up
    assert.equal(
      requireStepUp(stepped, { clock: c.clock }),
      false,
      "the same step-up is rejected once it is older than 5 minutes",
    );
  } finally {
    await db.close();
  }
});
