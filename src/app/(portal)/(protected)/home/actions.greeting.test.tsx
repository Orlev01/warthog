// E04-S39 — Home greets the person by their saved name (the home-loader half:
// the sibling `actions.ts` seam the thin `home/page.tsx` loader composes).
//
// RED-first: the home loader greets by the EMAIL's local part today (the real
// low-tier name was discarded at sign-up). This task has it greet by preferred
// name, else name, else the email's local part — which means the loader must read
// the person's low-tier identity fields, which it cannot decrypt without the DEK.
// So the loader grows a `keyWrapper` dep (to unwrap the person's DEK), exactly as
// the vault page-data loader does. Until the builder adds that, these tests fail —
// that absence IS the point of test-first. Do NOT implement anything to make them
// pass.
//
// Why the sibling `actions.ts` seam (not `page.tsx`): a Next `page.tsx` entry file
// may export only its framework fields, so the injectable, unit-testable loader
// lives in the plain sibling `createHomeActions({ db, keyWrapper })` factory (the
// convention's `createXHandler` pattern); the thin page reads the session cookie +
// the process-wide db/key-wrapper and renders the view. These tests drive the
// factory directly against an isolated in-memory PGlite with the REAL migrations
// and the REAL session/user/identity-field stores, and never assert on source text.
//
// ─── Acceptance criterion → tests ───────────────────────────────────────────────
//   AC2  GET /home for a person who saved the name 'Sam Rivera' greets 'Sam Rivera';
//        a preferred name takes precedence over the name; a person with no name
//        saved is greeted by the email's local part. The greeting always names the
//        SESSION's own person (design §5), never another account that exists.
//
// Every db handle is closed in a `finally`. We render the view with
// `react-dom/server` (no DOM/jsdom — React component / E2E testing is a per-job
// ADR) and read the emitted markup, exactly as the existing home tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createHomeActions } from "./actions";

import { DashboardView } from "@/components/home/dashboard-view";
import { saveIdentityField, type IdentityFieldKind } from "@/server/db/identity-fields";
import { createUser, type User } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// A frozen instant: a session created at T0 and read at T0 is comfortably inside
// both expiry windows, with no wall-clock dependence.
const T0 = new Date("2026-06-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);

// A local 256-bit KEK so the SAME key wrapper both wraps a person's DEK at seed and
// unwraps it inside the loader — so the loader can decrypt the low-tier name.
const LOCAL_KEK = new Uint8Array(32).fill(0x2a);
const keyWrapper: KeyWrapper = localAesKeyWrapper(LOCAL_KEK);

// The view model the loader returns — derived from the function itself so the test
// pins the BEHAVIOURAL fields without locking the props type's name.
type HomeView = Awaited<ReturnType<ReturnType<typeof createHomeActions>["load"]>>;

// The loader under test, with the real db seam and the key wrapper it needs to
// decrypt the low-tier name.
function makeActions(db: Db) {
  return createHomeActions({ db, keyWrapper });
}

// Seed a signed-in person: a real account with a wrapped DEK, their given low-tier
// identity fields stored DEK-encrypted under that same DEK, and a live session.
async function seedPerson(
  db: Db,
  email: string,
  fields: { kind: IdentityFieldKind; value: string }[] = [],
): Promise<{ user: User; session: Session }> {
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email, wrappedDek });
  for (const field of fields) {
    await saveIdentityField(db, { userId: user.id, kind: field.kind, value: field.value }, dek);
  }
  const created = await createSession(db, user.id, { clock, random: systemRandom });
  return { user, session: created.session };
}

// Visible text with tags stripped: exactly the words a sighted reader sees.
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function render(view: HomeView): string {
  return renderToStaticMarkup(<DashboardView {...view} />);
}

// ===========================================================================
// AC2 — the greeting prefers the saved name over the email's local part.
// ===========================================================================

// UI/UX pass content-52: Home greets by first name ("Hi, Sam"), not the full legal name.
test("a person who saved the name 'Sam Rivera' is greeted by its first name, not by their email prefix", async () => {
  const db = await freshDb();
  try {
    // An email whose local part is NOT the name, so the greeting can only read
    // 'Sam' from the saved low-tier name field.
    const { session } = await seedPerson(db, "sierrapenguin@people.example", [
      { kind: "name", value: "Sam Rivera" },
    ]);

    const view = await makeActions(db).load(session);
    assert.equal(view.personName, "Sam", "the loader greets by the first word of the saved low-tier name");

    const text = strip(render(view));
    assert.ok(text.includes("Hi, Sam"), `the home screen greets 'Sam', got: "${text}"`);
    assert.ok(!text.includes("Rivera"), `the greeting doesn't use the full name, got: "${text}"`);
    assert.ok(
      !text.includes("sierrapenguin"),
      `the greeting must not fall back to the email prefix when a name is saved, got: "${text}"`,
    );
  } finally {
    await db.close();
  }
});

test("a preferred name takes precedence over the name", async () => {
  const db = await freshDb();
  try {
    const { session } = await seedPerson(db, "koalatrombone@people.example", [
      { kind: "name", value: "Sam Rivera" },
      { kind: "preferred_name", value: "Sammy" },
    ]);

    const view = await makeActions(db).load(session);
    assert.equal(view.personName, "Sammy", "a saved preferred name wins over the name");

    const text = strip(render(view));
    assert.ok(text.includes("Sammy"), `the home screen greets by the preferred name, got: "${text}"`);
  } finally {
    await db.close();
  }
});

test("a person with no name saved is greeted by the email's local part", async () => {
  const db = await freshDb();
  try {
    const { session } = await seedPerson(db, "lonelemur@people.example", []);

    const view = await makeActions(db).load(session);
    assert.equal(
      view.personName,
      "lonelemur",
      "with no low-tier name saved the greeting falls back to the email's local part",
    );

    const text = strip(render(view));
    assert.ok(text.includes("lonelemur"), `the home screen greets by the email prefix, got: "${text}"`);
  } finally {
    await db.close();
  }
});

// Security (design §5): every member-scoped read takes the user id from the SESSION,
// never a client value — so the greeting names the session's OWN person, decrypting
// only THEIR low-tier name, never another account's.
test("the greeting names the session's own person, never another account's name", async () => {
  const db = await freshDb();
  try {
    const mine = await seedPerson(db, "quokkabanjo@people.example", [
      { kind: "name", value: "Alice Anderson" },
    ]);
    await seedPerson(db, "wombatviolin@people.example", [
      { kind: "name", value: "Bob Baxter" },
    ]); // a second, unrelated account

    const view = await makeActions(db).load(mine.session);
    assert.equal(view.personName, "Alice", "the loader greets the session's own person by name");
    assert.ok(
      !view.personName.includes("Bob"),
      `the loader must never name another account, got personName="${view.personName}"`,
    );
  } finally {
    await db.close();
  }
});
