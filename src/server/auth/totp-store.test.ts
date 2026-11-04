// E04-S26 — TOTP secret store (`src/server/auth/totp-store.ts`,
// `db/migrations/00XX_totp_secrets.sql`).
//
// RED-first: neither the store module nor the migration exists yet, so importing
// `./totp-store` throws and `freshDb()` has no `totp_secrets` table — every test
// here fails until the builder adds them. That absence IS the point of test-first;
// do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what set/get/remove DO and what is actually stored),
// never the source text of the module or the SQL file — a later rename that
// preserves behaviour must not redden them. There is no network and no Azure: the
// DEK is wrapped/unwrapped through the LOCAL AES KeyWrapper seam, and every store
// runs against an isolated in-memory PGlite with the real migrations (src/test/db).
//
// Why this store exists (design §4, §5): the sign-in handler reads a returning
// person's authenticator-app (TOTP) secret through an injected `TotpSecretStore`
// — `get(userId) -> base32 secret | null` (see src/app/(auth)/signin/handler.ts).
// Until now that store has only ever been a test fake, so authenticator-app sign-in
// cannot work outside tests. This task adds the real, persistent store: per person
// exactly one authenticator-app secret, stored DEK-ENCRYPTED (the person's 256-bit
// data key, envelope-encrypted via src/server/crypto/envelope.ts) so a leak of the
// row reveals no usable secret — the project rule that personal content is stored
// only DEK-encrypted, with only metadata in plaintext.
//
// The contract this task defines (the builder implements exactly this):
//
//   createTotpSecretStore(deps: { db: Db; keyWrapper: KeyWrapper })
//     -> { get, set, remove }
//
//   The returned object is the real `TotpSecretStore` the sign-in handler injects:
//   its methods are BOUND to the db + keyWrapper, so the handler calls `get(userId)`
//   with a userId alone (no db, no key) — see handler.ts. The store resolves the
//   person's data key itself: it reads that person's wrapped DEK (users.wrapped_dek)
//   and unwraps it through the KeyWrapper seam, then envelope-encrypts/decrypts the
//   secret under it.
//
//     set(userId, secret): Promise<void>
//       • enrol OR replace: stores the person's single authenticator-app secret,
//         DEK-encrypted; a second set for the same person REPLACES the first.
//     get(userId): Promise<string | null>
//       • the base32 secret for that person (decrypted), or null when they have
//         none. A userId that is not the owner's reads nothing (null) — member-scoped.
//     remove(userId): Promise<void>
//       • clears that person's secret; get then returns null. Safe when none exists.
//
// The schema this task defines: a `totp_secrets` migration creates a `totp_secrets`
// table (one current secret per person, hung off users(id)), applied by the shared
// migration runner. Tests below touch that table by name — that is the schema
// contract this task pins, the same way the users/recovery tests name their tables.
//
// Acceptance criteria → tests:
//   AC1 "After set(userId, secret), get(userId) returns the same base32 secret; get
//        for a person with no secret returns null; remove clears it." — round-trip,
//        the null-when-absent case, remove, and enrol-or-replace.
//   AC2 "The stored column holds only the envelope ciphertext: a direct SELECT of
//        the row never contains the base32 secret." — the persisted row carries no
//        copy of the plaintext secret, yet get still decrypts it back.
//   AC3 "A person's secret can be read only by their own user id: get for a
//        different user id returns null." — member-scoped by userId; two people's
//        secrets are isolated.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) "A handler rejects
//        malformed or oversized input with a 4xx, and a SQL-injection probe in an
//        input field cannot alter a query (parameter binding is used)." — a handler
//        built on the already-built boundary (`../http/validate`) rejects
//        malformed/oversized input with a 4xx BEFORE any query runs, and a probe
//        routed through the store travels as a bound value — it cannot drop or alter
//        the table. The handler below is a test fixture (the intended usage
//        pattern), not an implementation file.
//   Migration: the totp_secrets migration applies and re-running every migration
//        changes nothing (idempotent).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { createTotpSecretStore } from "./totp-store";
import { freshDb } from "../../test/db";
import { createUser, type User } from "../db/users";
import { loadMigrations, runMigrations, type Db } from "../db/index";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { systemRandom } from "../seams/random";
import { parseBody, HttpError } from "../http/validate";

// A fixed 32-byte (AES-256) local KEK: the store wraps/unwraps DEKs under the SAME
// KeyWrapper every user row was created with, so an unwrapped DEK decrypts the
// envelope the store wrote. No Azure, no network — the local dev/test wrapper.
const KEK = new Uint8Array(32).fill(7);
const keyWrapper: KeyWrapper = localAesKeyWrapper(KEK);

// Two realistic 32-character RFC 4648 base32 secrets (A–Z, 2–7) — the shape an
// authenticator enrolment produces (20 random bytes -> 32 base32 chars). Distinct,
// so a replace and the two-person isolation tests have genuinely different values.
const SECRET_A = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const SECRET_B = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// Create a genuine person row with a REAL wrapped DEK: a fresh random 256-bit data
// key wrapped under the test KEK (exactly how sign-up stores it). The store, given
// the userId, reads this wrapped_dek and unwraps it to encrypt/decrypt the secret.
// Distinct labels give distinct (unique) emails so two users never collide on
// users.email UNIQUE.
async function freshUser(db: Db, label: string): Promise<User> {
  const dek = systemRandom.randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek });
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove WHAT reached the query layer and HOW (bound value vs. spliced text). It
// returns no rows; it satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL otherwise — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// =====================================================================================
// AC1 — set/get round-trip, null when absent, remove clears, enrol-or-replace.
// =====================================================================================

test("after set(userId, secret), get(userId) returns the same base32 secret", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "roundtrip");
    const store = createTotpSecretStore({ db, keyWrapper });

    await store.set(user.id, SECRET_A);
    const read = await store.get(user.id);

    assert.equal(read, SECRET_A, "get returns exactly the base32 secret that was set");
  } finally {
    await db.close();
  }
});

test("get returns null for a person who has no enrolled secret", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "none");
    const store = createTotpSecretStore({ db, keyWrapper });

    // Nothing was ever set for this person — get must report null, not throw.
    assert.equal(await store.get(user.id), null, "a person with no secret reads null");
  } finally {
    await db.close();
  }
});

test("remove clears a person's secret: get returns null afterwards", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "remove");
    const store = createTotpSecretStore({ db, keyWrapper });

    await store.set(user.id, SECRET_A);
    assert.equal(await store.get(user.id), SECRET_A, "the secret is present before remove");

    await store.remove(user.id);
    assert.equal(await store.get(user.id), null, "after remove the person has no secret");
  } finally {
    await db.close();
  }
});

test("remove is safe when the person has no secret (a no-op, not a throw)", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "remove-absent");
    const store = createTotpSecretStore({ db, keyWrapper });

    await store.remove(user.id); // nothing to clear
    assert.equal(await store.get(user.id), null, "removing a non-existent secret leaves none");
  } finally {
    await db.close();
  }
});

test("set replaces an existing secret (enrol OR replace): get returns the latest", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "replace");
    const store = createTotpSecretStore({ db, keyWrapper });

    await store.set(user.id, SECRET_A);
    await store.set(user.id, SECRET_B); // a re-enrol replaces the first secret

    assert.equal(
      await store.get(user.id),
      SECRET_B,
      "a second set replaces the first — exactly one secret per person",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the stored column holds only the envelope ciphertext (no plaintext secret).
// =====================================================================================

test("a direct SELECT of the stored row never contains the base32 secret", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "ciphertext");
    const store = createTotpSecretStore({ db, keyWrapper });

    await store.set(user.id, SECRET_A);

    // The row this task's migration persists. A row MUST exist (else the absence
    // check below would pass vacuously), and the distinctive 32-char base32 secret
    // must not appear verbatim anywhere in it — only the DEK-envelope ciphertext may
    // be stored, and a ciphertext does not contain its plaintext as a substring. Its
    // presence would mean the secret was stored in the clear (project rule: personal
    // content is stored only DEK-encrypted).
    const stored = await db.query("SELECT * FROM totp_secrets");
    assert.ok(stored.rows.length >= 1, "setting a secret must persist a totp_secrets row");
    assert.ok(
      !JSON.stringify(stored.rows).includes(SECRET_A),
      "the plaintext base32 secret must never be stored; only its envelope ciphertext may be",
    );

    // ...yet the ciphertext still decrypts back to the secret through the store, so
    // what was stored IS an encryption of this person's secret (not a dropped value).
    assert.equal(
      await store.get(user.id),
      SECRET_A,
      "the stored ciphertext decrypts back to the person's secret",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — member-scoped: a secret is read only by its own user id; people are isolated.
// =====================================================================================

test("get for a different user id returns null (the secret is member-scoped)", async () => {
  const db = await freshDb();
  try {
    const alice = await freshUser(db, "scope-alice");
    const bob = await freshUser(db, "scope-bob");
    const store = createTotpSecretStore({ db, keyWrapper });

    await store.set(alice.id, SECRET_A); // only Alice enrols

    // Bob has no secret of his own: reading as Bob must NOT surface Alice's secret.
    assert.equal(await store.get(bob.id), null, "one person's secret is not readable as another");
    // Alice still reads her own.
    assert.equal(await store.get(alice.id), SECRET_A, "the owner reads their own secret");
  } finally {
    await db.close();
  }
});

test("two people's secrets are isolated: each get returns only that person's own", async () => {
  const db = await freshDb();
  try {
    const alice = await freshUser(db, "iso-alice");
    const bob = await freshUser(db, "iso-bob");
    const store = createTotpSecretStore({ db, keyWrapper });

    await store.set(alice.id, SECRET_A);
    await store.set(bob.id, SECRET_B);

    assert.equal(await store.get(alice.id), SECRET_A, "Alice reads Alice's secret");
    assert.equal(await store.get(bob.id), SECRET_B, "Bob reads Bob's secret");
    assert.notEqual(SECRET_A, SECRET_B, "the two secrets are genuinely different");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 [obligation] — validate at the boundary, parameterize every query.
//
// A route handler validates external input at the boundary (`parseBody`), then calls
// this task's store. The authenticator SECRET is the external input; the userId comes
// from the SESSION, never the request body (every member-scoped write takes userId
// from the session). A rejected input maps to a 4xx Response and NEVER reaches a
// query. This handler is a test fixture that EXERCISES the store — not an
// implementation file.
// =====================================================================================

function createEnrolHandler(
  store: ReturnType<typeof createTotpSecretStore>,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({ secret: z.string().min(1).max(256) });
  return async (req: Request): Promise<Response> => {
    try {
      const { secret } = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      // userId is the session's account id — never read from the client body.
      await store.set(sessionUserId, secret);
      return new Response(null, { status: 204 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/totp/enrol", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("a handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const store = createTotpSecretStore({ db, keyWrapper });
  const handler = createEnrolHandler(store, "11111111-1111-1111-1111-111111111111");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("a handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const store = createTotpSecretStore({ db, keyWrapper });
  const handler = createEnrolHandler(store, "11111111-1111-1111-1111-111111111111");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ secret: "A".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("a handler accepts a well-formed enrol and the secret round-trips through the store", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "enrol-ok");
    const store = createTotpSecretStore({ db, keyWrapper });
    const handler = createEnrolHandler(store, user.id);

    const res = await handler(jsonRequest(JSON.stringify({ secret: SECRET_A })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(await store.get(user.id), SECRET_A, "a valid enrol persists the secret");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the secret is stored as data and cannot drop the table", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "probe-secret");
    const store = createTotpSecretStore({ db, keyWrapper });
    const handler = createEnrolHandler(store, user.id);

    // A secret that, if concatenated into SQL rather than bound, would drop the table.
    const probe = "'); DROP TABLE totp_secrets; --";
    const res = await handler(jsonRequest(JSON.stringify({ secret: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) secret is accepted");
    assert.equal(await tableExists(db, "totp_secrets"), true, "the totp_secrets table must still exist");
    // It was bound and encrypted as an ordinary string value — it round-trips verbatim.
    assert.equal(
      await store.get(user.id),
      probe,
      "the probe is stored as literal data (bound, not interpreted as SQL)",
    );
  } finally {
    await db.close();
  }
});

test("get binds the userId as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const store = createTotpSecretStore({ db, keyWrapper });
  const probe = "x'; DROP TABLE totp_secrets; --";

  // The recording db returns no rows, so get resolves to null (or rejects on the
  // missing user); either way the issued statements are recorded for inspection. The
  // point: whatever userId is passed must travel as a BOUND value, never spliced into
  // the SQL text.
  try {
    await store.get(probe);
  } catch {
    // A missing user may reject — the recorded calls below are what this test asserts on.
  }

  assert.ok(db.calls.length >= 1, "get must issue at least one query");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the userId value is never concatenated into the SQL text");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
  assert.ok(
    db.calls.some((c) => c.values.includes(probe)),
    "the userId travels as a bound parameter value",
  );
});

// =====================================================================================
// Migration — the totp_secrets migration applies and a second run changes nothing.
// =====================================================================================

test("the totp_secrets migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // freshDb applied the project migrations; the totp_secrets relation now exists (a
    // non-throwing existence probe scoped to the one table under test — behaviour, not
    // source text).
    assert.equal(
      await tableExists(db, "totp_secrets"),
      true,
      "the totp_secrets table must exist after the project migrations",
    );

    // The project migration set includes this task's totp_secrets migration (its
    // recorded name carries "totp" — the task's named deliverable). We match on the
    // table deliverable rather than a fixed sequence number so an unrelated migration
    // landing first does not redden this test.
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => /totp/i.test(m.name)),
      "a totp_secrets migration must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing the CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing (idempotent).
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
