// E11-S15 — Vault identity page loader + actions
// (`src/app/(portal)/(protected)/vault/actions.ts`, mounted by the thin
// `vault/page.tsx`).
//
// RED-first: the vault identity actions seam does NOT exist yet, so importing
// `./actions` throws (ERR_MODULE_NOT_FOUND) and `tsc --noEmit` reddens on the
// missing module — every test here fails until the builder writes it. That
// absence IS the point of test-first; do NOT implement anything to make these
// pass. The builder writes `actions.ts` afterwards to satisfy exactly this
// contract and wires the thin `page.tsx` over it.
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the view it mounts; what
// each save CHANGES in the database; what each one REFUSES) against an isolated
// in-memory PGlite with the REAL migrations (src/test/db) and the REAL already-built
// seams the actions compose — the low-tier store (`identity-fields`, DEK-encrypted),
// the high-tier store (`high-tier-fields`, opaque device ciphertext only), the
// unlock-methods store (`vault-unlock-methods`) and the already-render-tested
// IdentityView (E11-S13). No test asserts on the source text of any module, so a
// later behaviour-preserving refactor (a rename, a moved import) stays green.
//
// Where the task names an entry/page file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `connectors/actions.ts`, `agents/[id]/actions.ts` and `settings/security/actions.ts`
// do) — NEVER on the thin `page.tsx`, which may export only its framework fields
// (`next build` rejects any other export, OBS-025). These tests drive that factory
// directly with real seams; the page mounts a thin loader + `"use server"` wrappers
// over it. A server PAGE that reads the session cookie + database cannot be rendered
// without a live request scope, so — exactly like the sibling permissions/activity
// loader tests — the loader's data assembly is pinned on the factory's `load`, and
// the SCREEN it mounts is pinned by feeding `load`'s output straight into
// <IdentityView/>.
//
// WHY this exists (task E11-S15; brief §"Identity vault" + "Device-held protection";
// design §4.1 low-tier + §4.2 device-held vault; CLAUDE.md — high-tier values and
// card data are encrypted in the BROWSER, the server only ever stores their
// ciphertext; every member-scoped read/write takes userId from the session, never a
// client value). The identity triad reads the person's identity server-side and
// mounts the view; the actions persist values, with high-tier values arriving ONLY
// as device ciphertext, gated by an unlock method existing.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createIdentityActions(deps: { db: Db; keyWrapper: KeyWrapper }): {
//     // the owner's identity, read member-scoped by session.userId and shaped into
//     // the props <IdentityView/> is mounted over: low-tier fields DECRYPTED,
//     // high-tier fields as METADATA ONLY (label/type, never the value/ciphertext).
//     load(session): Promise<{ lowTierFields; highTierFields }>
//
//     // store a NEW low-tier field (value DEK-encrypted server-side) for the
//     // session user. Owner = session.userId, never a value smuggled in the input.
//     saveLowTierField(session, { kind; value; movingOn? }): Promise<Result>
//
//     // store a NEW high-tier field. The value NEVER reaches the server — only the
//     // device-produced `ciphertext` and the plaintext metadata (type/label). This
//     // is REFUSED (via the unlock gate) when the account has no unlock method set.
//     saveHighTierField(session, { type; label; ciphertext }): Promise<Result>
//
//     // raise an existing low-tier field to high tier: save its high-tier ciphertext
//     // FIRST, then REMOVE the low-tier value. Gated like saveHighTierField, and
//     // member-scoped (another person's / a nonexistent field id is refused and
//     // nothing is created or removed). fieldId is validated at the boundary.
//     raiseFieldToHighTier(session, { fieldId; type; label; ciphertext }): Promise<Result>
//
//     // set (or clear) the "moving on" date on the session user's own field.
//     // Member-scoped; fieldId and the date are validated at the boundary.
//     setMovingDate(session, { fieldId; movingOn }): Promise<Result>
//   }
//
//   Result = { ok: true } | { ok: false; reason: string }   // never a silent success
//
//   • every read/write is member-scoped by session.userId (the project rule + INV-102):
//     another person's data is never read, changed or removed by id.
//   • high-tier values arrive ONLY as device ciphertext (the server holds no vault key),
//     and a high-tier write is refused when the account has no unlock method set.
//   • input is validated at the boundary (zod → a 4xx HttpError) BEFORE anything is
//     written, so malformed / oversized input writes nothing (INV-102). A malformed
//     field id is rejected as a 4xx BEFORE it can reach `WHERE id = $1` as a cast
//     (OBS-049). Every value reaches storage bound as a query parameter, so a value
//     shaped like SQL is stored as data and cannot alter a query.
//   • the module reads no process.env and holds no secret (INV-103): config flows from
//     src/server/config.ts alone, so no ambient env value lands in any output.
//
// ─── NOTE on the acceptance-criterion wording vs. this codebase ──────────────────────
// AC2 says "a field id that is not a positive INTEGER is rejected with a 4xx". That
// phrasing is generic obligation boilerplate (serial catalogue ids); in Warthog
// `identity_fields.id` is a `uuid` (db/migrations/0022_identity_fields.sql —
// gen_random_uuid()), and the just-built sibling actions validate ids with `z.uuid()`.
// The obligation here is OBS-049 / validate-and-parameterize-input: a MALFORMED id is
// rejected at the boundary with a 4xx before it can reach `WHERE id = $1` as a cast.
// We honour the obligation using the ACTUAL id shape — and the malformed probes below
// include a bare integer, a negative, a decimal and the empty string, so "not a
// positive integer is rejected" holds true as a special case of "not a well-formed
// uuid is rejected".
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's identity and mounts IdentityView over
//        it; saveHighTierField stores only device ciphertext and is refused (via the
//        unlock gate) when the account has no unlock method set.
//   AC2  raiseFieldToHighTier removes the low-tier value once its high-tier ciphertext
//        is saved; a refused raise removes nothing and creates nothing; a field id that
//        is not a well-formed uuid is rejected with a 4xx (not a raw cast).
//   AC3  a signed-in user cannot READ or CHANGE another user's identity by id (filtered
//        by session user id).
//   AC4  a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
//        probe in an input field cannot alter a query (parameter binding).  [validate-and-parameterize-input]
//   AC5  no secret value lands in a loaded/saved result; config is read from env.      [secrets-from-env]
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb(). The signed-in person is a REAL user row (every vault
// table's user_id is a foreign key to users(id)) whose stored wrapped DEK really
// unwraps under the test KeyWrapper, so a low-tier value round-trips decrypted. We
// render IdentityView with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR), exactly as the sibling view + loader tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createIdentityActions } from "./actions";

import { IdentityView } from "@/components/vault/identity-view";
import { createUser } from "@/server/db/users";
import {
  saveIdentityField,
  listIdentityFields,
} from "@/server/db/identity-fields";
import {
  listHighTierFields,
  getHighTierCiphertext,
} from "@/server/db/high-tier-fields";
import { saveWrappedKey, listMethods } from "@/server/db/vault-unlock-methods";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper
const NOW = new Date("2026-06-01T00:00:00.000Z");

// A real local KeyWrapper (dev/test), exactly the one a non-production composition
// root selects — so wrap/unwrap is genuine, not a stub.
function makeKeyWrapper(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so a low-tier value saved by the actions round-trips decrypted
// through the read, and the loader can decrypt what it reads back. Emails are
// uniquified so parallel test files never collide on users.email UNIQUE.
async function makeUserWithDek(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek,
  });
  return { userId: user.id, dek };
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id. Editing the vault is
// gated elsewhere (step-up on release), so stepped-up state is left null here.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Build the identity actions under test with the real db + keyWrapper seams.
function makeActions(db: Db, keyWrapper: KeyWrapper) {
  return createIdentityActions({ db, keyWrapper });
}

// Open the high-tier unlock gate for `userId` by giving the account a passphrase
// unlock method (an unambiguously valid unlock method — not "recovery", which the
// gate treats as insufficient). With a method set, a high-tier write is allowed.
async function seedUnlockMethod(db: Db, userId: string): Promise<void> {
  await saveWrappedKey(db, {
    userId,
    method: "passphrase",
    wrappedKey: `WRAPPED_VK_${userId}`,
  });
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Visible text with tags stripped: the words a sighted reader sees (no attributes).
function strip(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- types/casts derived from the factory (so tests don't hard-code a type NAME) ----
type Actions = ReturnType<typeof createIdentityActions>;
type SaveResult = Awaited<ReturnType<Actions["saveLowTierField"]>>;

// Cast a loose object (what an untrusted form body could carry) to a method's input
// type, so a test can pass a partial edit, a malformed value, or a smuggled rogue key
// without a type error — exactly what an untrusted body could carry.
const lowInput = (o: Record<string, unknown>): Parameters<Actions["saveLowTierField"]>[1] =>
  o as unknown as Parameters<Actions["saveLowTierField"]>[1];
const highInput = (o: Record<string, unknown>): Parameters<Actions["saveHighTierField"]>[1] =>
  o as unknown as Parameters<Actions["saveHighTierField"]>[1];
const raiseInput = (o: Record<string, unknown>): Parameters<Actions["raiseFieldToHighTier"]>[1] =>
  o as unknown as Parameters<Actions["raiseFieldToHighTier"]>[1];
const moveInput = (o: Record<string, unknown>): Parameters<Actions["setMovingDate"]>[1] =>
  o as unknown as Parameters<Actions["setMovingDate"]>[1];

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// Assert a save is REJECTED — either a thrown 4xx HttpError or a reported
// { ok: false } refusal, never a silent success. (A refusal that depends on stored
// state — the unlock gate being closed, or a field that is not this person's — may
// legitimately be reported rather than thrown; this accepts both.)
async function assertSaveRejected(label: string, fn: () => Promise<SaveResult>): Promise<void> {
  let result: SaveResult | undefined;
  try {
    result = await fn();
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a thrown rejection must be a 4xx HttpError, got ${String(err)}`,
    );
    return;
  }
  assert.equal(
    (result as { ok: boolean }).ok,
    false,
    `${label}: the save must be refused (ok:false), not a silent success`,
  );
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's identity and mounts IdentityView over
// it; saveHighTierField stores only device ciphertext and is refused (via the unlock
// gate) when the account has no unlock method set.
// =====================================================================================

test("the loader returns the session user's identity and mounts IdentityView over it (low-tier values + high-tier labels)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "loader-ok");
    // A low-tier field (DEK-encrypted by the store) and a high-tier field (stored as
    // opaque device ciphertext + metadata). The sentinel ciphertext must never surface
    // in the loaded screen (the high-tier read is metadata only).
    const LOW_VALUE = "Oren Quokka Levy";
    const HIGH_LABEL = "AU passport";
    const HIGH_CT = "v1:LOADER_HIGHTIER_CT_SENTINEL_passport";
    await saveIdentityField(db, { userId, kind: "name", value: LOW_VALUE }, dek);
    const actions = makeActions(db, keyWrapper);
    await seedUnlockMethod(db, userId);
    await actions.saveHighTierField(
      sessionFor(userId),
      highInput({ type: "passport", label: HIGH_LABEL, ciphertext: HIGH_CT }),
    );

    const props = await actions.load(sessionFor(userId));

    // The loader hands back the owner's decrypted low-tier value and the high-tier
    // metadata (label/type), never the high-tier ciphertext.
    assert.ok(
      props.lowTierFields.some((f: { value?: string }) => f.value === LOW_VALUE),
      `the loader returns the owner's decrypted low-tier value; got ${JSON.stringify(props.lowTierFields)}`,
    );
    assert.ok(
      props.highTierFields.some((f: { label?: string }) => f.label === HIGH_LABEL),
      `the loader returns the owner's high-tier field metadata; got ${JSON.stringify(props.highTierFields)}`,
    );
    assert.ok(
      !JSON.stringify(props.highTierFields).includes(HIGH_CT),
      "the high-tier ciphertext never appears in the loaded screen (metadata only)",
    );

    // "mounts IdentityView": the loader's output IS the screen's data — feeding it
    // straight into the already-render-tested view renders the owner's identity.
    const markup = renderToStaticMarkup(
      <IdentityView lowTierFields={props.lowTierFields} highTierFields={props.highTierFields} />,
    );
    assert.ok(strip(markup).includes("About you"), "mounting IdentityView renders the identity screen");
    assert.ok(markup.includes(LOW_VALUE), "the owner's low-tier value renders as an editable control");
    assert.ok(strip(markup).includes(HIGH_LABEL), "the owner's high-tier label renders, locked");
    assert.ok(!markup.includes(HIGH_CT), "the high-tier ciphertext is never rendered");
  } finally {
    await db.close();
  }
});

test("saveHighTierField is refused (via the unlock gate) when the account has no unlock method set — and nothing is stored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "no-unlock");
    const actions = makeActions(db, keyWrapper);

    // Precondition: the account has no unlock method.
    assert.deepEqual(await listMethods(db, userId), [], "the account starts with no unlock method");

    await assertSaveRejected("saveHighTierField(no unlock method)", () =>
      actions.saveHighTierField(
        sessionFor(userId),
        highInput({ type: "passport", label: "AU passport", ciphertext: "v1:should-not-store" }),
      ),
    );

    // Nothing was stored — the refusal is safe, not a silent partial write.
    assert.deepEqual(
      await listHighTierFields(db, userId),
      [],
      "a refused high-tier save stores no high-tier field",
    );
  } finally {
    await db.close();
  }
});

test("with an unlock method set, saveHighTierField stores ONLY the device ciphertext (metadata read never exposes it; the ciphertext round-trips verbatim)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "high-ok");
    await seedUnlockMethod(db, userId);
    const actions = makeActions(db, keyWrapper);

    // The browser produces the ciphertext; the server stores it verbatim. A unique
    // sentinel so any occurrence in a metadata read is an unambiguous leak.
    const CT = "v1:HIGHTIER_CT_SENTINEL_9q7X_driver_licence";
    const result = await actions.saveHighTierField(
      sessionFor(userId),
      highInput({ type: "driver_licence", label: "NSW licence", ciphertext: CT }),
    );
    assert.equal((result as { ok: boolean }).ok, true, "the high-tier save succeeds with an unlock method set");

    // The metadata read exposes label + type only — never the ciphertext.
    const metadata = await listHighTierFields(db, userId);
    assert.equal(metadata.length, 1, "exactly one high-tier field was stored");
    assert.equal(metadata[0]!.label, "NSW licence", "the label is stored as plaintext metadata");
    assert.equal(metadata[0]!.type, "driver_licence", "the type is stored as plaintext metadata");
    assert.ok(
      !JSON.stringify(metadata).includes(CT),
      "the ciphertext never appears in the metadata read (stored as device ciphertext only)",
    );

    // …and the stored ciphertext round-trips verbatim to its owner (proving the device
    // ciphertext — and only it — was stored; the server never saw a plaintext value).
    const stored = await getHighTierCiphertext(db, userId, metadata[0]!.id);
    assert.equal(stored, CT, "the device ciphertext is stored verbatim and returned to its owner");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — raiseFieldToHighTier removes the low-tier value once its high-tier ciphertext
// is saved; a refused raise removes nothing and creates nothing; a malformed field id
// is rejected with a 4xx (OBS-049).
// =====================================================================================

test("raiseFieldToHighTier removes the low-tier value once its high-tier ciphertext is saved", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "raise-ok");
    await seedUnlockMethod(db, userId);
    const actions = makeActions(db, keyWrapper);

    // A low-tier field the person decides to protect.
    const LOW_VALUE = "Frequent flyer QF 1234567";
    const seeded = await saveIdentityField(db, { userId, kind: "preference", value: LOW_VALUE }, dek);
    assert.ok(
      (await listIdentityFields(db, userId, dek)).some((f) => f.id === seeded.id),
      "precondition: the low-tier field exists before the raise",
    );

    const CT = "v1:RAISED_CT_SENTINEL_frequent_flyer";
    const result = await actions.raiseFieldToHighTier(
      sessionFor(userId),
      raiseInput({ fieldId: seeded.id, type: "custom", label: "Frequent flyer", ciphertext: CT }),
    );
    assert.equal((result as { ok: boolean }).ok, true, "the raise succeeds with an unlock method set");

    // The low-tier value is REMOVED — the field no longer appears in the low-tier read,
    // and its old value is gone.
    const low = await listIdentityFields(db, userId, dek);
    assert.ok(!low.some((f) => f.id === seeded.id), "the raised low-tier field is removed by id");
    assert.ok(!low.some((f) => f.value === LOW_VALUE), "the raised low-tier value is gone");

    // …and the high-tier field now exists, with its device ciphertext stored verbatim.
    const high = await listHighTierFields(db, userId);
    const raised = high.find((f) => f.label === "Frequent flyer");
    assert.ok(raised != null, "the raised field now exists as a high-tier field");
    assert.equal(raised!.type, "custom", "the raised field's type is stored");
    assert.equal(
      await getHighTierCiphertext(db, userId, raised!.id),
      CT,
      "the raised field's device ciphertext is stored verbatim",
    );
  } finally {
    await db.close();
  }
});

test("a raise refused by the unlock gate removes the low-tier value from NOTHING and creates no high-tier field", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "raise-gated");
    const actions = makeActions(db, keyWrapper);
    // No unlock method ⇒ the gate is closed.
    const seeded = await saveIdentityField(db, { userId, kind: "preference", value: "Protect me" }, dek);

    await assertSaveRejected("raiseFieldToHighTier(no unlock method)", () =>
      actions.raiseFieldToHighTier(
        sessionFor(userId),
        raiseInput({ fieldId: seeded.id, type: "custom", label: "Protect me", ciphertext: "v1:nope" }),
      ),
    );

    // The low-tier value SURVIVES (no data loss on a refused raise) and no stray
    // high-tier field was created.
    const low = await listIdentityFields(db, userId, dek);
    assert.ok(low.some((f) => f.id === seeded.id && f.value === "Protect me"), "the low-tier field survives a refused raise");
    assert.deepEqual(await listHighTierFields(db, userId), [], "a refused raise creates no high-tier field");
  } finally {
    await db.close();
  }
});

test("raiseFieldToHighTier refuses a well-formed but NONEXISTENT field id and creates no high-tier field", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "raise-missing");
    await seedUnlockMethod(db, userId);
    const actions = makeActions(db, keyWrapper);

    // A syntactically valid uuid that is nobody's field — there is nothing to raise.
    await assertSaveRejected("raiseFieldToHighTier(nonexistent field)", () =>
      actions.raiseFieldToHighTier(
        sessionFor(userId),
        raiseInput({ fieldId: randomUUID(), type: "custom", label: "Ghost", ciphertext: "v1:ghost" }),
      ),
    );

    // The high-tier ciphertext is NOT saved against a field that does not exist — no
    // stray high-tier row is left behind.
    assert.deepEqual(
      await listHighTierFields(db, userId),
      [],
      "raising a nonexistent field creates no high-tier field",
    );
  } finally {
    await db.close();
  }
});

test("a malformed field id is rejected with a 4xx before any query (OBS-049) — for both raiseFieldToHighTier and setMovingDate", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "bad-id");
    await seedUnlockMethod(db, userId);
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // Not a well-formed uuid — including a bare integer, a negative, a decimal, the
    // empty string, whitespace and a SQL-shaped id. Each is rejected at the boundary
    // BEFORE it can reach `WHERE id = $1` as a cast (so it never surfaces as a 500, and
    // a SQL-shaped id never reaches a query). "A bare integer is rejected" subsumes the
    // criterion's "not a positive integer".
    const badIds = ["5", "-1", "1.5", "", "   ", "not-a-uuid", "x'; DROP TABLE identity_fields; --"];
    for (const badId of badIds) {
      await assertRejects4xx(`raiseFieldToHighTier(id=${JSON.stringify(badId)})`, () =>
        actions.raiseFieldToHighTier(
          session,
          raiseInput({ fieldId: badId, type: "custom", label: "x", ciphertext: "v1:x" }),
        ),
      );
      await assertRejects4xx(`setMovingDate(id=${JSON.stringify(badId)})`, () =>
        actions.setMovingDate(session, moveInput({ fieldId: badId, movingOn: "2027-03-01" })),
      );
    }

    // The tables are intact — no SQL-shaped id was ever executed.
    assert.equal(await tableExists(db, "identity_fields"), true, "the identity_fields table survives");
    assert.equal(await tableExists(db, "high_tier_fields"), true, "the high_tier_fields table survives");
  } finally {
    await db.close();
  }
});

test("setMovingDate sets and clears the moving-on date on the session user's own field", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "moving");
    const actions = makeActions(db, keyWrapper);
    const seeded = await saveIdentityField(
      db,
      { userId, kind: "postal_address", value: "123 Quokka St, Perth" },
      dek,
    );

    // Set the moving-on date.
    const set = await actions.setMovingDate(sessionFor(userId), moveInput({ fieldId: seeded.id, movingOn: "2027-03-01" }));
    assert.equal((set as { ok: boolean }).ok, true, "setting the moving-on date succeeds");
    let field = (await listIdentityFields(db, userId, dek)).find((f) => f.id === seeded.id);
    assert.ok(field != null, "the address field still exists after setting its moving date");
    assert.equal(String(field!.movingOn).slice(0, 10), "2027-03-01", "the moving-on date is stored");

    // Clear it again (null).
    const cleared = await actions.setMovingDate(sessionFor(userId), moveInput({ fieldId: seeded.id, movingOn: null }));
    assert.equal((cleared as { ok: boolean }).ok, true, "clearing the moving-on date succeeds");
    field = (await listIdentityFields(db, userId, dek)).find((f) => f.id === seeded.id);
    assert.equal(field!.movingOn, null, "the moving-on date is cleared");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a signed-in user cannot READ or CHANGE another user's identity by id (filtered
// by session user id).
// =====================================================================================

test("the loader reads ONLY the session user's identity — another person's fields never appear", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "read-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "read-other");
    await seedUnlockMethod(db, alice.userId);
    await seedUnlockMethod(db, bob.userId);
    const actions = makeActions(db, keyWrapper);

    await saveIdentityField(db, { userId: alice.userId, kind: "name", value: "Alice Alpha" }, alice.dek);
    await actions.saveHighTierField(
      sessionFor(alice.userId),
      highInput({ type: "passport", label: "Alice passport", ciphertext: "v1:alice-ct" }),
    );
    await saveIdentityField(db, { userId: bob.userId, kind: "name", value: "Bob Beta" }, bob.dek);

    const bobsScreen = await actions.load(sessionFor(bob.userId));

    // Bob sees only Bob.
    assert.ok(bobsScreen.lowTierFields.some((f: { value?: string }) => f.value === "Bob Beta"), "Bob sees his own low-tier field");
    const whole = JSON.stringify(bobsScreen);
    assert.ok(!whole.includes("Alice Alpha"), "Alice's low-tier value never appears on Bob's screen");
    assert.ok(!whole.includes("Alice passport"), "Alice's high-tier label never appears on Bob's screen");
  } finally {
    await db.close();
  }
});

test("a signed-in user cannot CHANGE another person's identity by id — the other person's fields are untouched and nothing is created", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "change-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "change-attacker");
    await seedUnlockMethod(db, bob.userId); // Bob's gate is open — only ownership stops him
    const actions = makeActions(db, keyWrapper);

    // Alice's postal address, with no moving date set.
    const alicesField = await saveIdentityField(
      db,
      { userId: alice.userId, kind: "postal_address", value: "1 Alice Ave" },
      alice.dek,
    );

    // Bob, holding Alice's real field id, tries to set a moving date on it and to raise
    // it to high tier. Both are refused (member-scoped by Bob's session id).
    await assertSaveRejected("setMovingDate(bob → alice's field)", () =>
      actions.setMovingDate(sessionFor(bob.userId), moveInput({ fieldId: alicesField.id, movingOn: "2030-01-01" })),
    );
    await assertSaveRejected("raiseFieldToHighTier(bob → alice's field)", () =>
      actions.raiseFieldToHighTier(
        sessionFor(bob.userId),
        raiseInput({ fieldId: alicesField.id, type: "custom", label: "stolen", ciphertext: "v1:stolen" }),
      ),
    );

    // Alice's field is byte-for-byte unchanged: still low tier, still present, no moving
    // date, value intact.
    const alicesLow = await listIdentityFields(db, alice.userId, alice.dek);
    const stillThere = alicesLow.find((f) => f.id === alicesField.id);
    assert.ok(stillThere != null, "Alice's field still exists");
    assert.equal(stillThere!.value, "1 Alice Ave", "Alice's value is unchanged");
    assert.equal(stillThere!.movingOn, null, "Alice's moving date was not set by Bob");

    // Nothing was created for Bob (the borrowed id made him no high-tier field) and
    // Alice gained no high-tier field either.
    assert.deepEqual(await listHighTierFields(db, bob.userId), [], "Bob's refused attempts created no high-tier field");
    assert.deepEqual(await listHighTierFields(db, alice.userId), [], "Alice gained no high-tier field from Bob's attempt");
  } finally {
    await db.close();
  }
});

test("saveLowTierField takes the owner from the session — a userId smuggled in the input is ignored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const session = await makeUserWithDek(db, keyWrapper, "scope-session");
    const victim = await makeUserWithDek(db, keyWrapper, "scope-victim");
    const actions = makeActions(db, keyWrapper);

    // The input tries to write the field under the victim's id.
    const result = await actions.saveLowTierField(
      sessionFor(session.userId),
      lowInput({ kind: "name", value: "Smuggled Name", userId: victim.userId }),
    );
    assert.equal((result as { ok: boolean }).ok, true, "the save succeeds under the session user");

    // The field landed under the SESSION user, never the smuggled victim id.
    const mine = await listIdentityFields(db, session.userId, session.dek);
    assert.ok(mine.some((f) => f.value === "Smuggled Name"), "the field is stored under the session user");
    const victimsFields = await listIdentityFields(db, victim.userId, victim.dek);
    assert.ok(
      !victimsFields.some((f) => f.value === "Smuggled Name"),
      "the smuggled userId never redirected the write to another person",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
// probe in an input field is bound as data (parameter binding).
// [obligation:validate-and-parameterize-input]
// =====================================================================================

test("malformed input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "malformed");
    await seedUnlockMethod(db, userId); // open the high-tier gate so the ONLY rejection reason is the bad shape
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // Low tier: an unknown kind, and a value that is not a string.
    await assertRejects4xx("saveLowTierField(unknown kind)", () =>
      actions.saveLowTierField(session, lowInput({ kind: "biometric", value: "x" })),
    );
    await assertRejects4xx("saveLowTierField(value not a string)", () =>
      actions.saveLowTierField(session, lowInput({ kind: "name", value: 42 })),
    );

    // High tier: an unknown type, and a missing ciphertext.
    await assertRejects4xx("saveHighTierField(unknown type)", () =>
      actions.saveHighTierField(session, highInput({ type: "biometric", label: "x", ciphertext: "v1:x" })),
    );
    await assertRejects4xx("saveHighTierField(missing ciphertext)", () =>
      actions.saveHighTierField(session, highInput({ type: "passport", label: "x" })),
    );

    // Moving date: a value that is not a valid calendar date.
    const addr = await saveIdentityField(db, { userId, kind: "postal_address", value: "2 Bad Date Rd" }, dek);
    await assertRejects4xx("setMovingDate(invalid date)", () =>
      actions.setMovingDate(session, moveInput({ fieldId: addr.id, movingOn: "banana" })),
    );

    // Nothing was persisted by any rejected call.
    const low = await listIdentityFields(db, userId, dek);
    assert.ok(!low.some((f) => f.value === "x" || f.value === "42"), "no malformed low-tier value was stored");
    assert.deepEqual(await listHighTierFields(db, userId), [], "no malformed high-tier field was stored");
    assert.equal(
      low.find((f) => f.id === addr.id)!.movingOn,
      null,
      "the invalid moving date left the address unchanged",
    );
  } finally {
    await db.close();
  }
});

test("oversized input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "oversized");
    await seedUnlockMethod(db, userId);
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);
    const HUGE = "x".repeat(100_000);

    await assertRejects4xx("saveLowTierField(oversized value)", () =>
      actions.saveLowTierField(session, lowInput({ kind: "preference", value: HUGE })),
    );
    await assertRejects4xx("saveHighTierField(oversized label)", () =>
      actions.saveHighTierField(session, highInput({ type: "custom", label: HUGE, ciphertext: "v1:x" })),
    );

    assert.deepEqual(await listIdentityFields(db, userId, dek), [], "no oversized low-tier field was stored");
    assert.deepEqual(await listHighTierFields(db, userId), [], "no oversized high-tier field was stored");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a low-tier value is bound as data: the table survives and the value round-trips", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "sqli-low");
    const actions = makeActions(db, keyWrapper);

    // If the value were concatenated into the statement text it would corrupt the query
    // (or run the trailing statement); bound as a parameter it is inert — stored as data
    // (and here additionally DEK-encrypted before it is bound).
    const probe = "Robert'); DROP TABLE identity_fields; --";
    const result = await actions.saveLowTierField(sessionFor(userId), lowInput({ kind: "name", value: probe }));
    assert.equal((result as { ok: boolean }).ok, true, "a value shaped like SQL is accepted and stored as data");

    assert.equal(await tableExists(db, "identity_fields"), true, "the identity_fields table survives the probe");
    const low = await listIdentityFields(db, userId, dek);
    assert.ok(low.some((f) => f.value === probe), "the SQL-shaped value round-trips verbatim as data (decrypted)");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a high-tier label and ciphertext is bound as data: the table survives and the values round-trip", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "sqli-high");
    await seedUnlockMethod(db, userId);
    const actions = makeActions(db, keyWrapper);

    const probeLabel = "AU'); DROP TABLE high_tier_fields; --";
    const probeCt = "v1:robert'); DROP TABLE high_tier_fields; --";
    const result = await actions.saveHighTierField(
      sessionFor(userId),
      highInput({ type: "passport", label: probeLabel, ciphertext: probeCt }),
    );
    assert.equal((result as { ok: boolean }).ok, true, "SQL-shaped label/ciphertext are accepted and stored as data");

    assert.equal(await tableExists(db, "high_tier_fields"), true, "the high_tier_fields table survives the probe");
    const high = await listHighTierFields(db, userId);
    assert.equal(high.length, 1, "exactly one high-tier field was stored");
    assert.equal(high[0]!.label, probeLabel, "the SQL-shaped label round-trips verbatim as data");
    assert.equal(
      await getHighTierCiphertext(db, userId, high[0]!.id),
      probeCt,
      "the SQL-shaped ciphertext round-trips verbatim as data",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret value lands in a loaded/saved result; config is read from env.
// [obligation:secrets-from-env] — the module reads no process.env and holds no secret,
// so no ambient env value can leak into what it stores or the screen it loads.
// =====================================================================================

test("no ambient env secret leaks into any stored row or the loaded screen; the actions run from their injected seams alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the actions do not reach for an ambient database URL: point it at a decoy and
  // rely solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "env-user");
    await seedUnlockMethod(db, userId);
    const actions = makeActions(db, keyWrapper);

    const low = await actions.saveLowTierField(sessionFor(userId), lowInput({ kind: "name", value: "Env User" }));
    assert.equal((low as { ok: boolean }).ok, true, "the low-tier save works from the injected seams with a decoy env present");
    const high = await actions.saveHighTierField(
      sessionFor(userId),
      highInput({ type: "passport", label: "Env passport", ciphertext: "v1:env-ct" }),
    );
    assert.equal((high as { ok: boolean }).ok, true, "the high-tier save works from the injected seams");

    // The decoy appears in neither the loaded screen…
    const props = await actions.load(sessionFor(userId));
    assert.equal(props.lowTierFields[0]!.value, "Env User", "the loader works from its injected inputs alone");
    assert.ok(!JSON.stringify(props).includes(DECOY), "no ambient env value is folded into the loaded screen");

    // …nor the stored rows.
    assert.ok(
      !JSON.stringify(await listIdentityFields(db, userId, dek)).includes(DECOY),
      "no ambient env value is folded into the stored low-tier field",
    );
    assert.ok(
      !JSON.stringify(await listHighTierFields(db, userId)).includes(DECOY),
      "no ambient env value is folded into the stored high-tier field",
    );
  } finally {
    await db.close();
    if (prevDecoy === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prevDecoy;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
});
