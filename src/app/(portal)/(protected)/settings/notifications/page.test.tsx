// E12-S19 — Notification settings page loader
// (`src/app/(portal)/(protected)/settings/notifications/`).
//
// RED-first: the notification-settings LOADER seam does NOT exist yet (the notifications
// dir holds only a placeholder `page.tsx`), so importing `createNotificationsActions`
// from `./actions` throws and every test here fails until the builder adds it. That
// absence IS the point of test-first — do NOT implement anything to make these pass; the
// builder writes the loader afterwards as the minimum code that turns these green.
//
// Why these tests live in a SIBLING of `page.tsx`: a Next `page.tsx` entry file may export
// ONLY its framework fields (its default page component), so the injectable, unit-testable
// loader logic can't live there without breaking `next build`. The thin `page.tsx` reads
// the signed-in session from the host-locked session cookie + the process-wide database,
// calls this seam's `load` to turn the verified session into <NotificationsView>'s props,
// binds the register / add-number / verify / save-prefs / send-test server actions, and
// renders the view. The testable loader lives in the plain sibling module `./actions`
// (`createNotificationsActions(deps).load`), so these tests drive it directly against an
// isolated in-memory PGlite with the REAL migrations (`@/test/db`) and the REAL stores
// (push-subscriptions, mobile-numbers, notification-prefs) — no network, no Azure — and
// none asserts on the source text of any module, so a behaviour-preserving refactor stays
// green.
//
// WHAT THE LOADER DOES (the acceptance criterion): it reads the session user's registered
// devices, their mobile numbers WITH the verification state of each, and their saved
// preferences (email fallback + delay, defaulting to the brief's on / 2 minutes when
// nothing is saved), and returns the data that mounts the already-render-tested
// <NotificationsView> (E12-S18). Member-scoped by `session.userId` (never a client value):
// a person never sees another person's devices, numbers or preferences.
//
// The data slice `load` returns (the view's own prop shape):
//   { devices:  ReadonlyArray<{ id; label? }>,
//     numbers:  ReadonlyArray<{ id; number; verified }>,
//     emailFallback: boolean,
//     fallbackDelayMinutes: number }
//
// Acceptance criteria → tests:
//   AC1  the loader returns the session person's devices, numbers (with verified state)
//        and preferences, and that data mounts <NotificationsView> showing them.
//   AC1  with nothing saved, the loader returns the brief's defaults (email on, 2 minutes).
//   MS   a person never sees another person's devices, numbers or preferences (member
//        scope — CLAUDE.md: every member-scoped read has an ownership test).
//
// The view is rendered with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR), exactly as the sibling inbox/activity page tests do. Every
// db handle is closed in a `finally`; each test uses its own `freshDb()`.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createNotificationsActions } from "./actions";

import { NotificationsView } from "@/components/settings/notifications-view";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { registerSubscription } from "@/server/db/push-subscriptions";
import {
  addMobileNumber as addMobileNumberRepo,
  verifyMobileNumber as verifyMobileNumberRepo,
  listMobileNumbers,
} from "@/server/db/mobile-numbers";
import { saveNotificationPrefs } from "@/server/db/notification-prefs";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createOutbox, type Outbox } from "@/server/notify/outbox";
import type { Senders } from "@/server/notify/senders";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// --- the loader's return shape, declared here as the contract (see header) -------------

type NotificationsData = {
  devices: ReadonlyArray<{ id: string; label?: string }>;
  numbers: ReadonlyArray<{ id: string; number: string; verified: boolean }>;
  emailFallback: boolean;
  fallbackDelayMinutes: number;
};

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const HMAC_KEY = randomBytes(32);

const NOW = new Date("2026-11-15T12:00:00.000Z");
const clock: Clock = fixedClock(NOW);

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// The loader seam, built over the real seams. The senders are a dev outbox (unused by
// `load`, which only reads) so the factory's dep bundle is satisfied exactly as the page
// builds it.
function makeLoader(db: Db, keyWrapper: KeyWrapper) {
  const outbox: Outbox = createOutbox();
  const senders: Senders = { push: outbox, email: outbox, sms: outbox };
  return createNotificationsActions({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    keyWrapper,
    senders,
  });
}

async function makePerson(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

async function sessionFor(db: Db, userId: string): Promise<Session> {
  return (await createSession(db, userId, { clock, random: systemRandom })).session;
}

// Seed one device for `userId` (endpoint + keys DEK-encrypted at rest), returning its id.
async function seedDevice(
  db: Db,
  userId: string,
  dek: Uint8Array,
  token: string,
): Promise<string> {
  const stored = await registerSubscription(
    db,
    { userId, endpoint: `https://push.example.com/send/${token}`, keys: { p256dh: `p-${token}`, auth: `a-${token}` } },
    dek,
    clock,
  );
  return stored.id;
}

// Seed one mobile number for `userId`, verifying it when asked (through the real add +
// verify stores: the code is drawn, delivered to a throwaway outbox, read back and
// presented — the production path, so `verified` is set honestly).
async function seedNumber(
  db: Db,
  userId: string,
  number: string,
  verified: boolean,
): Promise<void> {
  const outbox = createOutbox();
  await addMobileNumberRepo(
    db,
    { userId, number },
    { clock, random: systemRandom, hmacKey: HMAC_KEY, smsSender: outbox },
  );
  if (verified) {
    const target = (await listMobileNumbers(db, userId)).find((n) => n.number === number)!;
    const sms = outbox.list().find((m) => m.channel === "sms" && m.recipient === number)!;
    const code = sms.body.match(/\b(\d{6})\b/)![1]!;
    const res = await verifyMobileNumberRepo(db, { userId, id: target.id, code }, { clock, hmacKey: HMAC_KEY });
    assert.equal(res.ok, true, `seed: the number ${number} must verify`);
  }
}

// --- markup helpers (no DOM), mirrored from the sibling component/page tests -----------

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Every <input>'s `value` attribute (SSR renders a controlled/default value here); used to
// prove the delay field reflects the loaded preference.
function inputValues(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b[^>]*?\/?>/gi)) {
    const v = m[0].match(/\bvalue="([^"]*)"/i);
    if (v) out.push(v[1]!);
  }
  return out;
}

// The page also passes the enabled SMS destinations from config; with none, the number
// controls are replaced by a one-line "not available yet" (content-30), so mount it with one.
function render(data: NotificationsData): string {
  return renderToStaticMarkup(<NotificationsView {...data} smsCountries={["AU"]} />);
}

// =====================================================================================
// AC1 — the loader returns the session person's devices, numbers (WITH their verification
// state) and preferences, and that data mounts <NotificationsView> showing them.
// =====================================================================================

test("the loader returns the session person's devices, numbers with verification state, and preferences", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");

    const d1 = await seedDevice(db, alice.userId, alice.dek, "phone");
    const d2 = await seedDevice(db, alice.userId, alice.dek, "laptop");
    await seedNumber(db, alice.userId, "+61400111222", true); // verified
    await seedNumber(db, alice.userId, "+61400333444", false); // unverified
    await saveNotificationPrefs(db, {
      userId: alice.userId,
      emailFallback: false,
      fallbackDelayMinutes: 15,
    });

    const data: NotificationsData = await makeLoader(db, keyWrapper).load(await sessionFor(db, alice.userId));

    // Devices — both registered devices, by the ids the store generated.
    assert.deepEqual(
      new Set(data.devices.map((x) => x.id)),
      new Set([d1, d2]),
      "the loader returns the person's registered devices",
    );

    // Numbers — both, each carrying its verification state.
    const verified = data.numbers.find((n) => n.number === "+61400111222");
    const unverified = data.numbers.find((n) => n.number === "+61400333444");
    assert.ok(verified, "the verified number is returned");
    assert.ok(unverified, "the unverified number is returned");
    assert.equal(verified!.verified, true, "the verified number carries verified = true");
    assert.equal(unverified!.verified, false, "the unverified number carries verified = false");

    // Preferences — exactly what was saved.
    assert.equal(data.emailFallback, false, "the saved email-fallback choice is returned");
    assert.equal(data.fallbackDelayMinutes, 15, "the saved delay is returned");

    // That data MOUNTS the view: both numbers are on the screen, the delay reflects, and
    // the two verification states are distinguishable (a verified state + a Verify action).
    const markup = render(data);
    const text = visibleText(markup);
    assert.ok(text.includes("+61400111222"), "the verified number is shown");
    assert.ok(text.includes("+61400333444"), "the unverified number is shown");
    assert.match(text, /verified/i, "a verified state is shown in words");
    assert.match(text, /\bverify\b/i, "an unverified number offers a Verify control");
    assert.ok(inputValues(markup).includes("15"), "the fallback-delay field reflects the saved value (15)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — with nothing saved, the loader returns the brief's defaults (email fallback ON, a
// 2-minute delay) and empty device/number lists, which the view renders.
// =====================================================================================

test("with no saved preferences, the loader returns the brief's defaults (email on, 2 minutes)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");

    const data: NotificationsData = await makeLoader(db, keyWrapper).load(await sessionFor(db, alice.userId));

    assert.equal(data.emailFallback, true, "email fallback defaults ON when nothing is saved");
    assert.equal(data.fallbackDelayMinutes, 2, "the delay defaults to 2 minutes when nothing is saved");
    assert.equal(data.devices.length, 0, "a person with no registered device has an empty device list");
    assert.equal(data.numbers.length, 0, "a person with no added number has an empty number list");

    const markup = render(data);
    assert.ok(inputValues(markup).includes("2"), "the fallback-delay field renders the default (2)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Member scope / ownership — a person never sees ANOTHER person's devices, numbers or
// preferences; the loader reads only the session user's own rows (never a client value).
// =====================================================================================

test("a person never sees another person's devices, numbers or preferences", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");

    // Alice's own device + number + preferences.
    const aliceDevice = await seedDevice(db, alice.userId, alice.dek, "alice-phone");
    await seedNumber(db, alice.userId, "+61400111000", true);
    await saveNotificationPrefs(db, { userId: alice.userId, emailFallback: false, fallbackDelayMinutes: 7 });

    // Bob's own device + number + preferences (distinct digits so leaks are visible).
    const bobDevice = await seedDevice(db, bob.userId, bob.dek, "bob-phone");
    await seedNumber(db, bob.userId, "+61400222999", true);
    await saveNotificationPrefs(db, { userId: bob.userId, emailFallback: true, fallbackDelayMinutes: 25 });

    const data: NotificationsData = await makeLoader(db, keyWrapper).load(await sessionFor(db, alice.userId));

    // Only Alice's device + number; never any of Bob's.
    assert.deepEqual(data.devices.map((x) => x.id), [aliceDevice], "only Alice's device is returned");
    assert.deepEqual(
      data.numbers.map((n) => n.number),
      ["+61400111000"],
      "only Alice's number is returned",
    );
    assert.equal(data.fallbackDelayMinutes, 7, "Alice's own delay is returned, not Bob's");
    assert.equal(data.emailFallback, false, "Alice's own email-fallback choice is returned, not Bob's");

    // Nothing of Bob's leaks into the returned data or onto Alice's screen.
    const serialised = JSON.stringify(data);
    assert.ok(!serialised.includes(bobDevice), "no returned entry carries another person's device id");
    assert.ok(!serialised.includes("+61400222999"), "no returned entry carries another person's number");
    assert.ok(
      !visibleText(render(data)).includes("+61400222999"),
      "another person's number is never on this person's screen",
    );
  } finally {
    await db.close();
  }
});
