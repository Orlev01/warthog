// E01-S13 — envelope decryption pins the GCM tag length (`src/server/crypto/envelope.ts`).
//
// This HARDENS the E01-S07 envelope module (which already exists). Operator review
// flagged that Node accepts truncated GCM tags by default, and that a tampered row
// too short to hold a nonce plus a full tag must never crash or (worse) decrypt.
// These tests pin the HARDENED BEHAVIOUR, never the source text of the module — a
// later rename that preserves behaviour must not redden them.
//
// What the hardening must guarantee (this task's contract):
//   • decrypt requires a FULL 16-byte GCM tag (authTagLength 16): an envelope whose
//     tag has been truncated to fewer than 16 bytes is rejected, even when the
//     truncated tag is a genuine PREFIX of the real one. [AC1]
//   • decrypt rejects an envelope whose decoded length is shorter than the 12-byte
//     nonce plus the 16-byte tag with a DELIBERATE error — not a low-level
//     node:crypto crash (a raw TypeError) and not plaintext. [AC2]
//   • a correctly produced envelope still round-trips to the exact plaintext. [AC3]
//
// RED vs preservation (why some tests fail today and some already pass):
//   • The too-short tests (AC2) are the RED drivers. Today decrypt reaches
//     node:crypto with a mis-sliced short buffer and throws a raw `TypeError`
//     ("Invalid authentication tag length: N" / "Invalid initialization vector").
//     The AC wants "an error rather than a crash", so these assert the rejection is
//     a deliberate Error that is NOT that low-level TypeError — RED until the module
//     length-checks the decoded bytes BEFORE calling into node:crypto. Note: adding
//     `{ authTagLength: 16 }` alone does NOT make these pass — a pinned decipher
//     still throws a TypeError on a short tag — so they force the length guard too.
//   • The truncated-tag (AC1) and round-trip (AC3) tests mostly pass today; they
//     lock the hardened contract so a refactor to pin the tag length cannot regress
//     either the rejection of a short tag or the plaintext round-trip.
//
// The obligation ACs are proven by composing the REAL seams through test-FIXTURE
// handlers (the intended usage pattern, exactly as src/server/http/validate.test.ts
// does — these handlers are not implementation files):
//   • [obligation:validate-and-parameterize-input] (INV-102): a handler that reveals
//     a stored envelope validates its input at the boundary (malformed / oversized
//     input -> 4xx, never a 500) and reads the row with a PARAMETERIZED query, so a
//     SQL-injection probe in an input field cannot alter the query. [AC4]
//   • [obligation:secrets-from-env] (INV-103): the envelope module reads no
//     `process.env` and embeds no key — its only key material is the caller-supplied
//     DEK — so no ambient/env value can leak into an envelope or an error. [AC5]
//
// Tests use only node:crypto for key bytes and PGlite for the end-to-end query
// proof; they never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { encrypt, decrypt } from "./envelope";
import { parseBody, HttpError } from "../http/validate";
import { createDb } from "../db/index";

const DEK_BYTES = 32; // a 256-bit per-person data key
const NONCE_BYTES = 12; // 96-bit nonce (design §4.1)
const TAG_BYTES = 16; // full AES-GCM tag
const PREFIX = "v1:";

function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A plaintext with hyphens: the hyphen is NOT in the base64 alphabet, so if the
// whole string ever appears verbatim in the (base64) envelope it was not encrypted.
const SECRET = "SECRET-SAUCE-0013-do-not-leak";

// Decode the stored envelope (strip the `v1:` version marker, base64-decode) back to
// its raw `nonce || ciphertext || tag` bytes, so a test can tamper at the byte level.
function rawBytes(envelope: string): Buffer {
  assert.ok(envelope.startsWith(PREFIX), "fixture envelope must carry the v1 marker");
  return Buffer.from(envelope.slice(PREFIX.length), "base64");
}

// Re-wrap raw bytes as a storable `v1:` envelope (the inverse of `rawBytes`).
function wrap(bytes: Buffer): string {
  return PREFIX + bytes.toString("base64");
}

// Run decrypt and report whether it threw, so a test can assert on BOTH the outcome
// (threw vs returned) and the thrown value. Works for a sync-throw or async-reject
// implementation alike (decrypt is awaited).
async function caughtDecrypt(
  dek: Uint8Array,
  table: string,
  column: string,
  rowId: string,
  envelope: string,
): Promise<{ threw: true; error: unknown } | { threw: false; value: string }> {
  try {
    const value = await decrypt(dek, table, column, rowId, envelope);
    return { threw: false, value };
  } catch (error) {
    return { threw: true, error };
  }
}

// The AC2 discriminator: a too-short / malformed-length envelope must be rejected by
// a DELIBERATE error, not by a low-level node:crypto crash and never by returning
// plaintext. "A crash" here is operationalised as the raw TypeError that
// createDecipheriv/setAuthTag throw on an undersized IV or a non-16 tag; a deliberate
// length guard throws a plain Error whose message is not one of those internals.
function assertControlledRejection(
  result: { threw: true; error: unknown } | { threw: false; value: string },
  label: string,
): void {
  assert.equal(result.threw, true, `${label}: decrypt must reject — never return plaintext`);
  const err = (result as { error: unknown }).error;
  assert.ok(err instanceof Error, `${label}: the rejection must be a real Error`);
  assert.ok(
    !(err instanceof TypeError),
    `${label}: a too-short envelope must be rejected by a deliberate length check, ` +
      `not a low-level node:crypto TypeError crash`,
  );
  const message = String((err as Error).message ?? "");
  assert.ok(
    !/initialization vector/i.test(message) && !/authentication tag length/i.test(message),
    `${label}: the error must be deliberate, not a raw node:crypto internal failure (saw: "${message}")`,
  );
}

// --- AC3: a correctly produced envelope (a full 16-byte tag) still round-trips -----

test("a correctly produced envelope round-trips to the exact plaintext (full 16-byte tag)", async () => {
  const dek = freshDek();

  const envelope = await encrypt(dek, "memories", "body", "row-42", SECRET);

  // Sanity: a well-formed envelope is long enough to hold nonce + a full tag, and its
  // trailing tag is exactly 16 bytes — the length the hardened decrypt must require.
  const bytes = rawBytes(envelope);
  assert.ok(
    bytes.length >= NONCE_BYTES + TAG_BYTES,
    "a real envelope holds at least a nonce plus a full tag",
  );

  const back = await decrypt(dek, "memories", "body", "row-42", envelope);
  assert.equal(back, SECRET, "the hardened decrypt still recovers the exact plaintext");
});

test("round-trip survives across content shapes under the hardened decrypt", async () => {
  const dek = freshDek();
  const cases = ["", "a", "line one\nlínea dos — 🦟\tt鍵", SECRET.repeat(40)];
  for (let i = 0; i < cases.length; i += 1) {
    const plaintext = cases[i]!;
    const rowId = `row-${i}`;
    const back = await decrypt(
      dek,
      "memories",
      "body",
      rowId,
      await encrypt(dek, "memories", "body", rowId, plaintext),
    );
    assert.equal(back, plaintext, `content shape #${i} must round-trip byte-for-byte`);
  }
});

// --- AC1: a tag truncated to fewer than 16 bytes is rejected, prefix or not --------

test("decrypt rejects a tag truncated below 16 bytes, even when it is a prefix of the real tag", async () => {
  const dek = freshDek();
  // Non-empty ciphertext so nonce, ciphertext and tag are distinct regions.
  const envelope = await encrypt(dek, "memories", "body", "row-1", "a stored memory body");
  const bytes = rawBytes(envelope);
  const ciphertextEnd = bytes.length - TAG_BYTES;
  const realTag = bytes.subarray(ciphertextEnd); // the genuine 16-byte tag

  for (const k of [4, 8, 12, 15]) {
    // Keep the first k bytes of the REAL tag: a genuine prefix, not random bytes.
    const truncatedTag = realTag.subarray(0, k);
    assert.equal(
      Buffer.compare(truncatedTag, realTag.subarray(0, k)),
      0,
      "the truncated tag must be a true prefix of the real tag",
    );
    const tampered = wrap(Buffer.concat([bytes.subarray(0, ciphertextEnd), truncatedTag]));

    const result = await caughtDecrypt(dek, "memories", "body", "row-1", tampered);
    assert.equal(
      result.threw,
      true,
      `a tag truncated to ${k} bytes must be rejected, never decrypted`,
    );
    if (result.threw === false) {
      assert.notEqual(
        result.value,
        "a stored memory body",
        "a shortened-tag envelope must never recover the original plaintext",
      );
    }
  }
});

test("decrypt rejects a tag truncated below 16 bytes on an empty-ciphertext envelope", async () => {
  const dek = freshDek();
  const envelope = await encrypt(dek, "preferences", "value", "row-7", "");
  const bytes = rawBytes(envelope); // nonce(12) || tag(16), 28 bytes
  const realTag = bytes.subarray(NONCE_BYTES);

  for (const k of [4, 8, 12, 15]) {
    const tampered = wrap(Buffer.concat([bytes.subarray(0, NONCE_BYTES), realTag.subarray(0, k)]));
    const result = await caughtDecrypt(dek, "preferences", "value", "row-7", tampered);
    assert.equal(result.threw, true, `a ${k}-byte tag on an empty-ct envelope must be rejected`);
  }
});

// --- AC2: an envelope too short to hold nonce + tag is rejected with a deliberate ---
// --- error (not a crash, not plaintext). These are the RED drivers. ----------------

test("decrypt rejects an envelope shorter than nonce + tag with a deliberate error, not a crash", async () => {
  const dek = freshDek();

  // Decoded lengths strictly below NONCE_BYTES + TAG_BYTES (28). The lengths where
  // node:crypto currently throws a raw TypeError are exactly what the length guard
  // must intercept; the guard must reject ALL of them the same deliberate way.
  for (const len of [0, 1, 10, 11, 13, 14, 15, 27]) {
    const tooShort = wrap(Buffer.alloc(len, 0x7));
    const result = await caughtDecrypt(dek, "memories", "body", "row-1", tooShort);
    assertControlledRejection(result, `${len}-byte envelope`);
  }
});

test("decrypt rejects an empty (bodyless) envelope with a deliberate error, not a crash", async () => {
  const dek = freshDek();
  // Just the version marker and nothing after it — the decoded buffer is empty.
  const result = await caughtDecrypt(dek, "memories", "body", "row-1", PREFIX);
  assertControlledRejection(result, "empty v1: envelope");
});

test("a real envelope truncated into the tag (one byte short of a full tag) is rejected", async () => {
  const dek = freshDek();
  const envelope = await encrypt(dek, "memories", "body", "row-9", SECRET);
  const bytes = rawBytes(envelope);
  // Drop the final tag byte: the decoded buffer can no longer hold a full 16-byte tag.
  const truncated = wrap(bytes.subarray(0, bytes.length - 1));

  const result = await caughtDecrypt(dek, "memories", "body", "row-9", truncated);
  assert.equal(result.threw, true, "an envelope missing a tag byte must be rejected");
  if (result.threw === false) {
    assert.notEqual(result.value, SECRET, "a truncated envelope must never recover the plaintext");
  }
});

// =====================================================================================
// Obligation fixtures — the intended usage pattern composing the REAL seams.
// These handlers EXERCISE envelope + validate + db; they are test fixtures, NOT
// implementation files.
// =====================================================================================

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

// A db stand-in that records every call (so a test can prove WHAT reached the query
// layer) and returns a prepared result set. Matches the `Db.query(text, values?)` shape.
interface RecordingDb extends Queryable {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(rows: unknown[] = []): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
}

// Fixture: a handler that reveals a person's stored memory by decrypting its envelope.
// Input is validated at the boundary; the row is read with a PARAMETERIZED query
// filtered by the SESSION's userId (never a client value); the REAL decrypt recovers
// the plaintext. A rejection at the boundary becomes a 4xx, never a 500.
function createRevealHandler(
  db: Queryable,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({ memoryId: z.string().regex(/^[1-9][0-9]*$/) });
  return async (req: Request): Promise<Response> => {
    try {
      const { memoryId } = await parseBody(schema, req, { maxBytes: 16 * 1024 });
      const res = await db.query(
        "SELECT id, body FROM memories WHERE id = $1 AND user_id = $2",
        [memoryId, sessionUserId],
      );
      const row = res.rows[0] as { id: unknown; body: string } | undefined;
      if (!row) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      const plaintext = await decrypt(dek, "memories", "body", String(row.id), row.body);
      return new Response(JSON.stringify({ plaintext }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary would be an uncontrolled 500; surface it
      // so a test sees the raw failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/memories/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// --- AC4: the handler rejects malformed / oversized input with a 4xx (never a 500) --

test("the reveal handler rejects malformed JSON with a 4xx and never touches a query", async () => {
  const db = recordingDb();
  const handler = createRevealHandler(db, freshDek(), "user-1");

  const res = await handler(jsonRequest("{ not valid json at all"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the reveal handler rejects an oversized body with a 4xx before any query", async () => {
  const db = recordingDb();
  const handler = createRevealHandler(db, freshDek(), "user-1");

  // A schema-valid but oversized body (~20 KiB of digits): only the 16 KiB byte cap
  // can be the reason it is rejected, and the size check runs before any query.
  const res = await handler(jsonRequest(JSON.stringify({ memoryId: "1".repeat(20000) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

// --- AC4: a SQL-injection probe in an input field cannot alter a query --------------

test("a SQL-injection probe in the memoryId field is rejected at the boundary, never reaching a query", async () => {
  const db = recordingDb();
  const handler = createRevealHandler(db, freshDek(), "user-1");

  for (const probe of ["1 OR 1=1", "1); DROP TABLE memories; --", "nope'); DROP TABLE memories; --"]) {
    const res = await handler(jsonRequest(JSON.stringify({ memoryId: probe })));
    assert.ok(res.status >= 400 && res.status < 500, `probe "${probe}" must be a 4xx, got ${res.status}`);
  }
  assert.equal(db.calls.length, 0, "a mis-shaped id must be rejected before any query runs");
});

test("a conforming id is bound as a parameter and its envelope round-trips through the handler", async () => {
  const dek = freshDek();
  const sessionUserId = "user-7";
  const stored = await encrypt(dek, "memories", "body", "42", "my private note");
  const db = recordingDb([{ id: 42, body: stored }]);
  const handler = createRevealHandler(db, dek, sessionUserId);

  const res = await handler(jsonRequest(JSON.stringify({ memoryId: "42" })));

  assert.equal(res.status, 200, "a valid id reveals the stored memory");
  assert.deepEqual(await res.json(), { plaintext: "my private note" }, "the handler decrypts the envelope");

  assert.equal(db.calls.length, 1, "exactly one read runs for a valid id");
  const call = db.calls[0]!;
  // The id and the SESSION user id travel as bound values...
  assert.deepEqual(call.values, ["42", sessionUserId], "the id and session userId are bound parameters");
  // ...never concatenated into the statement text.
  assert.ok(call.text.includes("$1") && call.text.includes("$2"), "the query uses placeholders");
  assert.ok(!call.text.includes("42"), "the id is bound, never spliced into the SQL text");
  assert.ok(!call.text.includes(sessionUserId), "the userId is bound, never spliced into the SQL text");
});

test("end-to-end: the reveal handler cannot be SQL-injected and round-trips a real stored envelope (PGlite)", async () => {
  const dek = freshDek();
  const sessionUserId = "user-9";
  const db = await createDb("pglite:memory");
  try {
    await db.query(
      "CREATE TABLE memories (id integer PRIMARY KEY, user_id text NOT NULL, body text NOT NULL)",
    );
    const envelope = await encrypt(dek, "memories", "body", "42", "a secret to reveal");
    await db.query("INSERT INTO memories (id, user_id, body) VALUES ($1, $2, $3)", [
      42,
      sessionUserId,
      envelope,
    ]);

    const handler = createRevealHandler(db, dek, sessionUserId);

    // A valid id reveals the plaintext, decrypted through the real envelope module.
    const ok = await handler(jsonRequest(JSON.stringify({ memoryId: "42" })));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { plaintext: "a secret to reveal" });

    // A SQL-injection probe is rejected before any query — it cannot execute.
    const attack = await handler(
      jsonRequest(JSON.stringify({ memoryId: "42); DROP TABLE memories; --" })),
    );
    assert.ok(attack.status >= 400 && attack.status < 500, "the probe is a 4xx, not a 500");

    // The table and its row survive: the injection never ran (parameterization holds).
    const rows = (await db.query("SELECT id, body FROM memories")).rows as {
      id: number;
      body: string;
    }[];
    assert.equal(rows.length, 1, "the memories table still exists with its single row");
    assert.equal(rows[0]!.body, envelope, "the stored envelope is intact");
  } finally {
    await db.close();
  }
});

// --- AC5: secrets from env — the envelope module reads no env and embeds no key -----

test("the envelope module leaks no ambient/env value into an envelope or an error", async () => {
  const SENTINEL = "SENTINEL_SECRET_env_only_S13_9d4c";
  const KEY = "WARTHOG_ENVELOPE_SENTINEL";
  const saved = process.env[KEY];
  try {
    process.env[KEY] = SENTINEL;
    const dek = freshDek();

    // A produced envelope carries no ambient env value.
    const envelope = await encrypt(dek, "memories", "body", "row-1", "hello");
    assert.equal(envelope.includes(SENTINEL), false, "no env value leaks into the envelope");

    // A decrypt failure (tampered row) carries no ambient env value in its error.
    const tampered = wrap(Buffer.alloc(10, 0x7));
    const result = await caughtDecrypt(dek, "memories", "body", "row-1", tampered);
    assert.equal(result.threw, true);
    assert.equal(
      String(((result as { error: unknown }).error as Error)?.message ?? "").includes(SENTINEL),
      false,
      "no env value leaks into a decrypt error message",
    );
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
});

test("the only key material is the caller-supplied DEK — no embedded/ambient key decrypts", async () => {
  // Behavioural shadow of "no secret value in source/bundle": the module has no key of
  // its own, so an envelope is recoverable only with the exact DEK the caller passed.
  const dekA = freshDek();
  const dekB = freshDek();
  const envelope = await encrypt(dekA, "memories", "body", "row-1", SECRET);

  assert.equal(
    await decrypt(dekA, "memories", "body", "row-1", envelope),
    SECRET,
    "the caller's DEK recovers the plaintext",
  );

  const other = await caughtDecrypt(dekB, "memories", "body", "row-1", envelope);
  assert.equal(other.threw, true, "a different DEK must never decrypt");

  const zeroed = await caughtDecrypt(new Uint8Array(DEK_BYTES), "memories", "body", "row-1", envelope);
  assert.equal(zeroed.threw, true, "there is no all-zero / embedded fallback key");
});
