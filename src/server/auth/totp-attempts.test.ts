// Review fix W3.5 — authenticator-app sign-in is limited and single-use
// (`./totp-attempts`). The brief: "IF sign-in or code entry fails 5 times in 15 minutes
// for one account … THEN THE SYSTEM SHALL slow further attempts". verifyTotp alone accepts
// unlimited guesses and lets a code be replayed for its whole ±1-step window (90 s).
//
// checkTotpSignIn counts every presentation per account (atomically, BEFORE the code is
// checked, so parallel guesses cannot exceed the limit), refuses once 5 have failed inside
// a 15-minute window, and accepts each 30-second step at most once: a code from the step
// already used, or an earlier one, is refused. A success clears the failures.
//
// RFC 6238 vectors (SHA-1, the ASCII secret "12345678901234567890") give real codes for
// adjacent steps: at T=1111111109 s the code is 081804 (step 37037036) and at
// T=1111111111 s it is 050471 (step 37037037).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { checkTotpSignIn, TOTP_MAX_FAILURES, TOTP_FAILURE_WINDOW_MS } from "./totp-attempts";
import { createTotpSecretStore } from "./totp-store";
import { createUser } from "../db/users";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const AT_STEP_36 = new Date(1111111109 * 1000);
const CODE_STEP_36 = "081804";
const AT_STEP_37 = new Date(1111111111 * 1000);
const CODE_STEP_37 = "050471";
const STEP_36 = Math.floor(AT_STEP_36.getTime() / 30_000);
const STEP_37 = Math.floor(AT_STEP_37.getTime() / 30_000);

const keyWrapper = localAesKeyWrapper(randomBytes(32));

async function enrolled(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
  await createTotpSecretStore({ db, keyWrapper }).set(user.id, SECRET);
  return user.id;
}

function wrong(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

test("a correct code is accepted once; the same code again is refused", async () => {
  const db = await freshDb();
  try {
    const userId = await enrolled(db, "totp-once");
    const clock = fixedClock(AT_STEP_37);
    assert.deepEqual(await checkTotpSignIn(db, { userId, secret: SECRET, code: CODE_STEP_37 }, { clock }), { ok: true, step: STEP_37 });
    assert.deepEqual(
      await checkTotpSignIn(db, { userId, secret: SECRET, code: CODE_STEP_37 }, { clock }),
      { ok: false, reason: "invalid" },
      "a replay inside its 90-second window is refused",
    );
  } finally {
    await db.close();
  }
});

test("after a step is used, a code from an earlier step is refused even inside the skew window", async () => {
  const db = await freshDb();
  try {
    const userId = await enrolled(db, "totp-earlier");
    const clock = fixedClock(AT_STEP_37);
    assert.deepEqual(await checkTotpSignIn(db, { userId, secret: SECRET, code: CODE_STEP_37 }, { clock }), { ok: true, step: STEP_37 });
    assert.deepEqual(
      await checkTotpSignIn(db, { userId, secret: SECRET, code: CODE_STEP_36 }, { clock }),
      { ok: false, reason: "invalid" },
    );
  } finally {
    await db.close();
  }
});

test("5 failures in 15 minutes stop further attempts — even the right code — until the window passes", async () => {
  const db = await freshDb();
  try {
    const userId = await enrolled(db, "totp-limit");
    const clock = fixedClock(AT_STEP_36);
    for (let i = 0; i < TOTP_MAX_FAILURES; i++) {
      const result = await checkTotpSignIn(db, { userId, secret: SECRET, code: wrong(CODE_STEP_36) }, { clock });
      assert.deepEqual(result, { ok: false, reason: "invalid" }, `guess #${i + 1} is just wrong`);
    }
    const blocked = await checkTotpSignIn(db, { userId, secret: SECRET, code: CODE_STEP_36 }, { clock });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok ? "" : blocked.reason, "throttled", "the right code is refused while slowed");
    assert.ok(!blocked.ok && blocked.retryAfterMs > 0 && blocked.retryAfterMs <= TOTP_FAILURE_WINDOW_MS);

    // Once the window has passed, the person can sign in again (and the failures clear).
    const later = fixedClock(new Date(AT_STEP_36.getTime() + TOTP_FAILURE_WINDOW_MS + 60_000));
    const laterStep = Math.floor(later.now().getTime() / 30_000);
    assert.ok(laterStep > 37037036);
    const result = await checkTotpSignIn(db, { userId, secret: SECRET, code: wrong(CODE_STEP_36) }, { clock: later });
    assert.deepEqual(result, { ok: false, reason: "invalid" }, "a fresh window counts from one again");
  } finally {
    await db.close();
  }
});

test("a success clears earlier failures", async () => {
  const db = await freshDb();
  try {
    const userId = await enrolled(db, "totp-clear");
    const clock36 = fixedClock(AT_STEP_36);
    for (let i = 0; i < TOTP_MAX_FAILURES - 1; i++) {
      await checkTotpSignIn(db, { userId, secret: SECRET, code: wrong(CODE_STEP_36) }, { clock: clock36 });
    }
    assert.deepEqual(await checkTotpSignIn(db, { userId, secret: SECRET, code: CODE_STEP_36 }, { clock: clock36 }), {
      ok: true,
      step: STEP_36,
    });
    const clock37 = fixedClock(AT_STEP_37);
    for (let i = 0; i < TOTP_MAX_FAILURES - 1; i++) {
      const result = await checkTotpSignIn(db, { userId, secret: SECRET, code: wrong(CODE_STEP_37) }, { clock: clock37 });
      assert.deepEqual(result, { ok: false, reason: "invalid" }, "the count started again after the success");
    }
  } finally {
    await db.close();
  }
});

test("parallel guesses never get more than the limit checked", async () => {
  const db = await freshDb();
  try {
    const userId = await enrolled(db, "totp-race");
    const clock = fixedClock(AT_STEP_36);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        checkTotpSignIn(db, { userId, secret: SECRET, code: wrong(CODE_STEP_36) }, { clock }),
      ),
    );
    const checked = results.filter((r) => !r.ok && r.reason === "invalid").length;
    assert.equal(checked, TOTP_MAX_FAILURES, "only the first five guesses were checked; the rest were slowed");
  } finally {
    await db.close();
  }
});

test("failures on one account never slow another", async () => {
  const db = await freshDb();
  try {
    const a = await enrolled(db, "totp-a");
    const b = await enrolled(db, "totp-b");
    const clock = fixedClock(AT_STEP_36);
    for (let i = 0; i < TOTP_MAX_FAILURES + 2; i++) {
      await checkTotpSignIn(db, { userId: a, secret: SECRET, code: wrong(CODE_STEP_36) }, { clock });
    }
    assert.deepEqual(await checkTotpSignIn(db, { userId: b, secret: SECRET, code: CODE_STEP_36 }, { clock }), { ok: true, step: STEP_36 });
  } finally {
    await db.close();
  }
});
