// E13-S04 — the `get_skill` core tool, the obligation acceptance criteria
// (`src/server/mcp/tools/get-skill.ts` + its validation / parameterize / no-secret
// boundaries; INV-102 validate-and-parameterize-input, INV-103 secrets-from-env).
//
// RED-first: `./get-skill` does not exist yet, so importing `createGetSkillTool` throws
// and every test here fails until the builder writes the module. That absence IS the point
// of test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. The pinned tool contract is documented in
// the sibling `get-skill.test.ts`; this file depends on the same
// `createGetSkillTool({ db, keyWrapper })` factory and `handle(input, connection)` surface.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • the handler rejects a malformed / oversized / mis-shaped input with a 4xx
//       HttpError BEFORE any database access (a LANDMINE db throws a plain Error if
//       reached, so skipped validation surfaces as a non-4xx and reddens the test); and
//     • a SQL-injection probe in the `title` field cannot alter a query: the skills store
//       binds `user_id` as a parameter and matches the title in application code, so a
//       SQL-shaped title is inert — it returns `not_available`, errors nothing, and leaves
//       the real data intact and still fetchable (parameter binding is used).
//   AC [obligation:secrets-from-env] (INV-103) — the tool runs purely from its injected
//     `db` + `keyWrapper` seams and reads no `process.env`, so a decoy env secret never
//     lands in the returned result; config flows in, never baked in.
//
// Each real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) closed in a `finally`. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createGetSkillTool } from "./get-skill";
import { createUser } from "../../db/users";
import { createSkill, getSkillText, type NewSkill } from "../../db/skills";
import { freshDb } from "../../../test/db";
import { HttpError } from "../../http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

interface SkillResult {
  readonly status: string;
  readonly text?: string;
  readonly reason?: string;
}

const DEK_BYTES = 32;
const KEK_BYTES = 32;

const is4xx = (err: unknown): boolean =>
  err instanceof HttpError && err.status >= 400 && err.status < 500;

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

function connectionFor(userId: string): AgentConnection {
  const connectionId = randomBytes(16).toString("hex");
  return { userId, connectionId, agentId: connectionId, active: true };
}

function newSkillFor(userId: string, overrides: Partial<NewSkill> = {}): NewSkill {
  return {
    userId,
    title: "Travel booking",
    useThisWhen: "Use this when booking travel",
    fullText: "Prefer refundable fares; confirm dates before paying.",
    scope: "all",
    scopedAgentIds: [],
    enabled: true,
    ...overrides,
  } as NewSkill;
}

// A db seam whose every method throws: if validation is skipped and the handler reaches the
// db for an invalid input, the thrown error is a plain Error (NOT a 4xx HttpError) and the
// `is4xx` predicate fails the test — proving validation runs BEFORE any db access.
function landmineDb(): Db {
  return {
    query(): never {
      throw new Error("db.query must not run for invalid input");
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  } as Db;
}

// A KeyWrapper landmine: a valid input never needs it in the validation tests, and an
// invalid input must be rejected before any crypto work.
function landmineKeyWrapper(): KeyWrapper {
  return {
    wrap(): never {
      throw new Error("keyWrapper.wrap must not run for invalid input");
    },
    unwrap(): never {
      throw new Error("keyWrapper.unwrap must not run for invalid input");
    },
  } as KeyWrapper;
}

// A recording wrapper over a REAL db: it records each (text, values) and delegates, so a
// test can prove WHAT reached the query layer and HOW (bound value vs. spliced text).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(real: Db): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close() {
      return real.close();
    },
  };
}

// ===========================================================================
// AC [validate-and-parameterize-input] — a mis-shaped input is rejected with a 4xx BEFORE
// any db access. The db + keyWrapper are LANDMINES: reaching either before validating turns
// the rejection into a non-4xx and fails the test.
// ===========================================================================

test("get_skill rejects a mis-shaped input with a 4xx, before any db access", async () => {
  const tool = createGetSkillTool({ db: landmineDb(), keyWrapper: landmineKeyWrapper() });
  const conn = connectionFor("validate-person");

  await assert.rejects(() => tool.handle(42, conn), (e: unknown) => is4xx(e), "a number input is a 4xx");
  await assert.rejects(
    () => tool.handle("Travel booking", conn),
    (e: unknown) => is4xx(e),
    "a bare string input is a 4xx (the input is an object with a `title`)",
  );
  await assert.rejects(
    () => tool.handle({ reason: "looks relevant" }, conn),
    (e: unknown) => is4xx(e),
    "a MISSING title is a 4xx (a skill is fetched BY title)",
  );
  await assert.rejects(
    () => tool.handle({ title: 999 }, conn),
    (e: unknown) => is4xx(e),
    "a non-string title is a 4xx",
  );
});

test("get_skill rejects an OVERSIZED title or reason with a 4xx before any db access", async () => {
  const tool = createGetSkillTool({ db: landmineDb(), keyWrapper: landmineKeyWrapper() });
  const conn = connectionFor("oversize-person");

  await assert.rejects(
    () => tool.handle({ title: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized title is rejected with a 4xx",
  );
  await assert.rejects(
    () => tool.handle({ title: "Travel booking", reason: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized reason is rejected with a 4xx",
  );
});

test("get_skill accepts a small, well-formed input and reads the store (not a 4xx)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "accepted", keyWrapper);
    const skill = await createSkill(db, newSkillFor(userId), dek);

    const result = (await createGetSkillTool({ db, keyWrapper }).handle(
      { title: skill.title, reason: "ok" },
      connectionFor(userId),
    )) as SkillResult;
    assert.equal(result.status, "found", "a well-formed input is read, not rejected as a 4xx");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a SQL-injection probe in `title` is inert: it
// matches nothing, errors nothing, and leaves the real data intact and still fetchable.
// ===========================================================================

test("a SQL-shaped title is inert data: not_available, nothing dropped, real skill still fetchable", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "sql-probe", keyWrapper);
    const REAL_TITLE = "Travel booking";
    const REAL_TEXT = "Prefer refundable fares; confirm dates before paying.";
    await createSkill(db, newSkillFor(userId, { title: REAL_TITLE, fullText: REAL_TEXT }), dek);

    const tool = createGetSkillTool({ db, keyWrapper });
    const conn = connectionFor(userId);

    // A classic injection payload as the title.
    const probe = "Travel booking'; DROP TABLE skills; --";
    const probed = (await tool.handle({ title: probe }, conn)) as SkillResult;
    assert.equal(probed.status, "not_available", "a SQL-shaped title matches no skill — it is inert data");

    // If the probe had been concatenated into SQL, the skills table would be gone; it is
    // not — the real skill is still there and still fetchable both through the store and the
    // tool (proving the query was parameterized, not spliced).
    const stillThere = await getSkillText(db, userId, conn.agentId, REAL_TITLE, dek);
    assert.equal(stillThere, REAL_TEXT, "the skills table survived — the probe altered nothing");

    const afterProbe = (await tool.handle({ title: REAL_TITLE }, conn)) as SkillResult;
    assert.equal(afterProbe.status, "found", "the real skill is still fetchable after the probe");
    assert.equal(afterProbe.text, REAL_TEXT, "its full text is intact");
  } finally {
    await db.close();
  }
});

test("the title never reaches the SQL text; user_id travels as a bound parameter", async () => {
  const real = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(real, "bind-probe", keyWrapper);
    await createSkill(real, newSkillFor(userId, { title: "Travel booking" }), dek);

    const rec = recordingDb(real);
    const tool = createGetSkillTool({ db: rec, keyWrapper });
    const conn = connectionFor(userId);

    const probe = "x' OR '1'='1'; DROP TABLE skills; --";
    const result = (await tool.handle({ title: probe }, conn)) as SkillResult;
    assert.equal(result.status, "not_available", "the probe matches nothing");

    assert.ok(rec.calls.length >= 1, "at least one query was issued");
    assert.ok(
      rec.calls.some((c) => c.values.includes(userId)),
      "the owning user id travels as a BOUND value (member-scoped, parameterized)",
    );
    for (const call of rec.calls) {
      assert.ok(!call.text.includes(probe), "the attacker-supplied title is never spliced into the SQL text");
      assert.ok(
        !call.text.toUpperCase().includes("DROP TABLE"),
        "no injected statement appears in any SQL the tool issues",
      );
    }
  } finally {
    await real.close();
  }
});

// ===========================================================================
// AC [secrets-from-env] — the tool reads no process.env: a decoy env secret never appears
// in the returned result. The tool runs purely from its injected db + keyWrapper seams.
// ===========================================================================

test("get_skill reads no process.env: a decoy env secret never appears in the result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "secrets-env", keyWrapper);
    const skill = await createSkill(db, newSkillFor(userId), dek);

    const result = await createGetSkillTool({ db, keyWrapper }).handle(
      { title: skill.title, reason: "go" },
      connectionFor(userId),
    );
    assert.ok(
      !JSON.stringify(result ?? {}).includes(DECOY),
      "no ambient env value is folded into the returned result",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
