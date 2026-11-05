// E07-S13 — the `log_activity` core tool, the obligation acceptance criteria
// (`src/server/mcp/tools/log-activity.ts` + its validation / parameter-binding /
// config boundaries, design §6.2 + §9; INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env).
//
// RED-first: `./log-activity` does not exist yet, so importing `createLogActivityTool`
// throws and every test here fails until the builder writes the module. That absence
// IS the point of test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. The pinned tool contract is documented
// in the sibling `log-activity.test.ts`; this file depends on the same
// `createLogActivityTool({ recorder })` factory and `handle(input, connection)` surface.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • the handler rejects a malformed / oversized / mis-shaped input with a 4xx
//       HttpError BEFORE anything is written (the recorder is never called); and
//     • a SQL-injection probe in an input FIELD travels to the database as a BOUND
//       value — a sentinel table is intact afterwards and the probe round-trips as
//       inert data, so it cannot alter a query.
//   AC [obligation:secrets-from-env] (INV-103) — the tool runs purely from its injected
//     recorder and reads no `process.env`, so a decoy env secret never lands in a
//     written entry or the returned result; config flows in, never baked in.
//
// Every db handle is closed in a `finally`; the db-backed test uses its own `freshDb()`
// (an isolated in-memory PGlite with the real migrations). Tests never touch the
// network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createLogActivityTool } from "./log-activity";
import {
  createInMemoryRecorder,
  type ActivityEntry,
  type ActivityEntryInput,
  type ActivityRecorder,
} from "../../activity/recorder";
import { createDbRecorder, readActivity } from "../../activity/writer";
import { createUser, getUserById } from "../../db/users";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import { HttpError } from "../../http/validate";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const NOW = new Date("2026-11-20T09:30:00.000Z");
const CONN_ID = "conn-aa1";
const AGENT_ID = "agent-bb2";

function connectionFor(userId: string): AgentConnection {
  return { userId, connectionId: CONN_ID, agentId: AGENT_ID, active: true };
}

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

// A recorder spy that records every write WITHOUT persisting, so a validation test
// proves WHETHER a bad input reached the recorder at all.
function spyRecorder() {
  const calls: ActivityEntryInput[] = [];
  const recorder: ActivityRecorder = {
    async record(input: ActivityEntryInput): Promise<ActivityEntry> {
      calls.push(input);
      return {
        userId: input.userId,
        seq: 1,
        occurredAt: NOW.toISOString(),
        kind: input.kind,
        source: input.source,
        agentId: input.agentId,
        payload: input.payload,
        prevHash: "GENESIS",
        entryHash: "0".repeat(64),
      };
    },
  };
  return { recorder, calls };
}

const is4xx = (err: unknown): boolean =>
  err instanceof HttpError && err.status >= 400 && err.status < 500;

// ===========================================================================
// AC [validate-and-parameterize-input] — the handler rejects bad input with a 4xx
// BEFORE anything is written.
// ===========================================================================

test("log_activity rejects a mis-shaped input with a 4xx, before writing any entry", async () => {
  const { recorder, calls } = spyRecorder();
  const tool = createLogActivityTool({ recorder });
  const conn = connectionFor("validate-person");

  // A bare scalar is not the tool's object input.
  await assert.rejects(() => tool.handle(42, conn), (err: unknown) => is4xx(err), "a non-object input is a 4xx");
  // A wrong-typed reason is rejected (reason is a string field).
  await assert.rejects(
    () => tool.handle({ reason: 999 }, conn),
    (err: unknown) => is4xx(err),
    "a non-string reason is a 4xx",
  );
  // A non-numeric or non-positive amount is rejected (amount is an optional positive number).
  await assert.rejects(
    () => tool.handle({ amount: "lots" }, conn),
    (err: unknown) => is4xx(err),
    "a non-numeric amount is a 4xx",
  );
  await assert.rejects(
    () => tool.handle({ amount: -5 }, conn),
    (err: unknown) => is4xx(err),
    "a non-positive amount is a 4xx",
  );

  assert.equal(calls.length, 0, "no mis-shaped input is ever written");
});

test("log_activity accepts a small valid report but rejects an OVERSIZED one with a 4xx (never written)", async () => {
  const { recorder, calls } = spyRecorder();
  const tool = createLogActivityTool({ recorder });
  const conn = connectionFor("oversize-person");

  // A small, well-formed report is accepted and written …
  await tool.handle({ reason: "sent one email" }, conn);
  assert.equal(calls.length, 1, "a small valid report is written");

  // … but the SAME field, grossly oversized, is refused with a 4xx and never written.
  await assert.rejects(
    () => tool.handle({ reason: "x".repeat(500_000) }, conn),
    (err: unknown) => is4xx(err),
    "an oversized reason must be rejected with a 4xx HttpError",
  );
  assert.equal(calls.length, 1, "the oversized input is never written");
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a SQL-injection probe in an input field is
// bound, never executed: the database is intact and the probe round-trips as data.
// ===========================================================================

test("a SQL-injection probe in a log_activity field travels as a BOUND value and cannot alter a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "sql-probe", keyWrapper);

    // The real DB-backed recorder, so the agent-supplied summary actually reaches a
    // parameterized INSERT (the payload is DEK-encrypted into `payload_ct`).
    const dekFor = async (uid: string): Promise<Uint8Array> => {
      const user = await getUserById(db, uid);
      if (!user) throw new Error("no user");
      return keyWrapper.unwrap(user.wrappedDek);
    };
    const recorder = createDbRecorder({ db, clock: fixedClock(NOW), dekFor });
    const tool = createLogActivityTool({ recorder });

    // A probe that would drop the activity table if it were concatenated into SQL.
    const probe = "Robert'); DROP TABLE activity_entries; --";
    await tool.handle({ reason: probe }, connectionFor(userId));

    // The sentinel `users` row survives — nothing was dropped or altered.
    const users = await db.query("SELECT count(*)::int AS n FROM users WHERE id = $1", [userId]);
    assert.equal(users.rows[0]!.n, 1, "the injection could not drop/alter another table");

    // Exactly ONE entry was written (no extra injected statement ran) and the activity
    // table is still present — the DROP never executed.
    const count = await db.query(
      "SELECT count(*)::int AS n FROM activity_entries WHERE user_id = $1",
      [userId],
    );
    assert.equal(count.rows[0]!.n, 1, "the probe injected no extra statements");

    // The probe round-trips VERBATIM in the decrypted payload — stored as inert data,
    // never interpreted as SQL.
    const entries = await readActivity(db, userId, dek);
    assert.equal(entries.length, 1, "exactly one entry is readable back");
    assert.equal(entries[0]!.source, "agent_reported", "it is the agent-reported log entry");
    assert.equal(
      (entries[0]!.payload as Record<string, unknown>).reason,
      probe,
      "the probe is stored as a bound, literal value",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [secrets-from-env] — the tool reads no process.env: a decoy env secret never
// appears in a written entry or the returned result.
// ===========================================================================

test("log_activity reads no process.env: a decoy env secret never appears in a written entry or result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  try {
    // Capture the written entries through the real (redacting, chaining) in-memory recorder.
    const base = createInMemoryRecorder({ clock: fixedClock(NOW) });
    const entries: ActivityEntry[] = [];
    const recorder: ActivityRecorder = {
      async record(input: ActivityEntryInput): Promise<ActivityEntry> {
        const entry = await base.record(input);
        entries.push(entry);
        return entry;
      },
    };
    const tool = createLogActivityTool({ recorder });

    const result = await tool.handle({ reason: "wrote the report" }, connectionFor("secrets-env"));

    assert.ok(
      !JSON.stringify(result ?? {}).includes(DECOY),
      "no ambient env value is folded into the returned result",
    );
    assert.equal(entries.length, 1, "the report is written");
    assert.ok(
      !JSON.stringify(entries[0]).includes(DECOY),
      "no ambient env value is folded into the written activity entry",
    );
  } finally {
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
