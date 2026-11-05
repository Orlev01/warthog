// E09-S15 — Connectors read for the page, the obligation acceptance criteria
// (INV-102 validate-and-parameterize-input; INV-103 secrets-from-env).
//
// RED-first: `./page-data` does not exist yet, so importing `browseCatalogue` /
// `listConnectionsForPage` throws and every test here fails until the builder writes the
// module. That absence IS the point of test-first; do NOT implement anything to make
// these pass.
//
// The pinned reads are documented in the sibling `page-data.test.ts`; this file depends on
// the same surface and pins only the two obligation ACs, as BEHAVIOUR:
//
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) —
//     • VALIDATE: a handler on the `../http/validate` boundary rejects a malformed,
//       oversized or mis-typed browse input with a 4xx BEFORE the read runs (the handler
//       below is a TEST FIXTURE — the intended usage — not an implementation file); and
//     • PARAMETERIZE: the connections list-all read binds the person id as a parameter, so
//       a SQL-injection probe routed through it travels as a BOUND value (never spliced
//       into the SQL text) and cannot drop the table. The browse read is over the in-memory
//       catalogue index and reaches no query at all, so a probe in a browse field is inert
//       data that alters nothing.
//   AC5 [obligation:secrets-from-env] (INV-103) — the reads take `db`, the catalogue index
//       and the person id as INJECTED dependencies; they read no `process.env` and hold no
//       secret (config flows from `src/server/config.ts` alone). Shown behaviourally: a
//       decoy secret planted in the environment never appears in a browse or a connections
//       read, and both reads run purely from their injected inputs with no app env set.
//
// Database tests use `freshDb()` and a `recordingDb` that captures what reached the query
// layer; each real-db handle is closed in a `finally`. The catalogue index is built by the
// real loader over throwaway fixture files. Tests touch no network and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { browseCatalogue, listConnectionsForPage } from "./page-data";
import { loadCatalogue, type CatalogueIndex } from "./catalogue";
import { createConnection } from "../db/connections";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- catalogue fixture (self-contained; mirrors page-data.test.ts) ----------------

const FIXTURE_ENTRIES: Array<Record<string, unknown>> = [
  {
    id: "google-gmail",
    name: "Gmail",
    aliases: ["google mail"],
    category: "email",
    auth_kind: "oauth2",
    base_url: "https://gmail.googleapis.com",
    auth: {
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    },
  },
  {
    id: "acme-mail",
    name: "Acme Mail",
    aliases: ["acme"],
    category: "email",
    auth_kind: "api_key",
    base_url: "https://api.acme.example",
    auth: { header: "Authorization: Bearer {key}" },
  },
];

function fixtureIndex(): CatalogueIndex {
  const dir = mkdtempSync(join(tmpdir(), "warthog-page-data-obl-"));
  for (const entry of FIXTURE_ENTRIES) {
    writeFileSync(join(dir, `${String(entry.id)}.json`), JSON.stringify(entry));
  }
  try {
    return loadCatalogue({ dir, isOAuthClientConfigured: () => true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- helpers ----------------------------------------------------------------------

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (a bound value vs. spliced text). Returns no rows.
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

// Whether a relation of this exact name exists on this handle (a non-throwing probe scoped
// to the one table under test — behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL text
// (the parameterize half of INV-102), scoped to each recorded call.
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// ===========================================================================
// AC4 (VALIDATE) — a handler on the validation boundary rejects bad browse input.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// catalogue browse. A rejected input maps to a 4xx Response and the read is never reached.
// This handler is a TEST FIXTURE that exercises the module — it is not an implementation
// file.
// ===========================================================================

function browseHandler(index: CatalogueIndex): (req: Request) => Promise<{ status: number; reached: boolean }> {
  // The browse input is a category and/or a free-text search term; both are short. The caps
  // keep an absurd value out, and `maxBytes` rejects a grossly oversized body before parse.
  const schema = z.object({
    category: z.string().min(1).max(64).optional(),
    query: z.string().min(1).max(200).optional(),
  });
  return async (req: Request) => {
    let reached = false;
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      reached = true;
      browseCatalogue(index, body);
      return { status: 200, reached };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, reached };
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test
      // sees the raw failure rather than a masked success.
      return { status: 500, reached };
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/connectors/browse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("[validate-and-parameterize-input] the handler rejects malformed JSON with a 4xx before the read runs", async () => {
  const handler = browseHandler(fixtureIndex());
  const res = await handler(jsonRequest("{ not valid json"));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(res.reached, false, "malformed input never reaches the browse read");
});

test("[validate-and-parameterize-input] the handler rejects an oversized body with a 4xx before the read runs", async () => {
  const handler = browseHandler(fixtureIndex());
  // ~8 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ query: "a".repeat(8 * 1024) })));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(res.reached, false, "an oversized body never reaches the browse read");
});

test("[validate-and-parameterize-input] the handler rejects a mis-typed field with a 4xx before the read runs", async () => {
  const handler = browseHandler(fixtureIndex());
  // category must be a string — a number is a schema violation, rejected before the read.
  const res = await handler(jsonRequest(JSON.stringify({ category: 123 })));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(res.reached, false, "a mis-typed field never reaches the browse read");
});

test("[validate-and-parameterize-input] a well-formed browse body is accepted (the cap admits a real search term)", async () => {
  const handler = browseHandler(fixtureIndex());
  const res = await handler(jsonRequest(JSON.stringify({ category: "email" })));
  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(res.reached, true, "a valid body reaches the browse read");
});

// ===========================================================================
// AC4 (PARAMETERIZE) — the browse read reaches NO query; a probe in a browse field is
// inert data. The connections read binds the person id; a probe cannot alter the query.
// ===========================================================================

test("[validate-and-parameterize-input] a SQL-injection probe in a browse field is inert and alters nothing", () => {
  const index = fixtureIndex();
  const probe = "x'; DROP TABLE connections; --";

  // The catalogue is in memory; the probe is only ever compared as a literal key. It matches
  // nothing (a miss), so the browse offers the request affordance and returns no entries —
  // and the real catalogue entries are untouched.
  const browse = browseCatalogue(index, { query: probe });
  assert.equal(browse.groups.flatMap((g) => g.entries).length, 0, "the probe matches no entry");
  assert.equal(browse.canRequest, true, "the probe is treated as a plain (missed) search term");
  assert.equal(browse.query, probe, "the probe round-trips verbatim — nothing in it was interpreted");

  // A fresh browse still returns the two fixture entries: the probe created/destroyed nothing.
  const all = browseCatalogue(index, {});
  assert.equal(all.groups.flatMap((g) => g.entries).length, 2, "the catalogue is intact after the probe");
});

test("[validate-and-parameterize-input] the connections read binds the person id as a parameter, never spliced", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE connections; --";

  await listConnectionsForPage(db, probe, fixtureIndex());

  assertBoundNotSpliced(db, probe);
});

test("[validate-and-parameterize-input] a SQL-injection person id cannot alter the query or drop the table", async () => {
  const db = await freshDb();
  try {
    const index = fixtureIndex();
    // A real connection exists for a real person; the probe must not reach or harm it.
    const owner = await makeUser(db, "probe-owner");
    await createConnection(
      db,
      { userId: owner, connectorId: "google-gmail", accountLabel: "oren@gmail.com", credentials: { accessToken: "atok" } },
      randomBytes(32),
      fixedClock(new Date("2026-04-01T09:00:00.000Z")),
    );

    const probe = "p'); DROP TABLE connections; --";
    // Bound as a parameter, the probe is at worst a value the typed `user_id` column
    // rejects (OBS-049: an id-typed selector); it is NEVER executed as SQL. Either outcome
    // — the DB rejects it, or it simply matches nothing — proves the injection did not run.
    let rejectedOrEmpty = false;
    try {
      const list = await listConnectionsForPage(db, probe, index);
      rejectedOrEmpty = Array.isArray(list) && list.length === 0;
    } catch {
      rejectedOrEmpty = true;
    }
    assert.ok(rejectedOrEmpty, "the probe is bound, not executed — it yields nothing or is rejected");

    // The decisive proof: the table and the real owner's connection are intact — the probe
    // altered nothing.
    assert.equal(await tableExists(db, "connections"), true, "the connections table is intact");
    const owned = await listConnectionsForPage(db, owner, index);
    assert.equal(owned.length, 1, "the real owner's connection survived the probe");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 [secrets-from-env] — the reads use injected deps only; no ambient env value leaks
// into a browse or a connections read, and both run with no app env configured.
// ===========================================================================

test("[secrets-from-env] no ambient env secret appears in a browse or a connections read", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevClient = process.env.CONNECTOR_GOOGLE_GMAIL_CLIENT_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  process.env.CONNECTOR_GOOGLE_GMAIL_CLIENT_SECRET = DECOY;

  const db = await freshDb();
  try {
    const index = fixtureIndex();

    // The browse read runs purely from the injected index — no env value is folded in.
    const browse = browseCatalogue(index, {});
    assert.ok(!JSON.stringify(browse).includes(DECOY), "no ambient env secret appears in the browse read");
    assert.ok(browse.groups.flatMap((g) => g.entries).length > 0, "and the browse still returns the catalogue");

    // The connections read runs purely from the injected db + index + person id.
    const user = await makeUser(db, "env-user");
    await createConnection(
      db,
      { userId: user, connectorId: "google-gmail", accountLabel: "oren@gmail.com", credentials: { accessToken: "atok" } },
      randomBytes(32),
      fixedClock(new Date("2026-04-01T09:00:00.000Z")),
    );
    const list = await listConnectionsForPage(db, user, index);
    assert.equal(list.length, 1, "the connections read works from its injected inputs alone");
    assert.ok(!JSON.stringify(list).includes(DECOY), "no ambient env secret appears in the connections read");
  } finally {
    await db.close();
    restoreEnv("WARTHOG_DECOY_SECRET", prevDecoy);
    restoreEnv("CONNECTOR_GOOGLE_GMAIL_CLIENT_SECRET", prevClient);
  }
});
