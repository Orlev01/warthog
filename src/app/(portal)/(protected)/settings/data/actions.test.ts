// E16-S11 — Data & privacy page actions
// (`src/app/(portal)/(protected)/settings/data/actions.ts`).
//
// RED-first: the data-and-privacy seam does NOT exist yet (the settings/data dir holds
// only a placeholder `page.tsx`), so importing `./actions` throws and every test here
// fails until the builder adds it. That absence IS the point of test-first — do NOT
// implement anything to make these pass; the builder writes `actions.ts` afterwards as
// the minimum code that turns these green.
//
// These tests pin BEHAVIOUR (what each action RETURNS, what it RESTORES/DELETES, what it
// REFUSES) against an isolated in-memory PGlite with the REAL migrations (`@/test/db`)
// and the REAL sibling services — the export builder, the import service, the
// imported-history archive, the account-deletion service, the session + step-up seams, a
// real `KeyWrapper`, the dev outbox and a spy `DeletionExecutor`. No test asserts on the
// source text of any module, so a later behaviour-preserving refactor (a rename, a moved
// import) stays green. No test touches the network or Azure.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may
// export ONLY its framework fields, so it cannot carry an injectable, unit-testable seam
// without breaking `next build`. The thin protected-page loader reads the session +
// database and renders <DataView> (E16-S10) wired to these actions; the testable logic —
// building the export bundle, restoring an uploaded import, and deleting the account —
// lives in the plain sibling module `actions.ts` (the convention's `createXActions(deps)`
// factory, the same shape as the already-built security / notifications actions). These
// tests drive that factory directly with real seams; the page wires thin server-action
// wrappers over it.
//
// ─── THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it) ──────
//
//   createDataActions(deps): {
//     load(session):                        Promise<DataPageData>
//     exportData(session):                  Promise<ExportResult>
//     importData(session, upload):          Promise<ImportResult>
//     deleteAccount(session, input):        Promise<ActionResult>
//   }
//   // the exact phrase the delete action requires (one source of truth; the page passes
//   // the SAME value to <DataView>'s `confirmationPhrase` so the gate on screen and the
//   // server-side check can never drift).
//   export const DELETE_ACCOUNT_CONFIRMATION: string
//
//   deps: {
//     db: Db; clock: Clock; keyWrapper: KeyWrapper;   // resolves the session person's DEK
//     revoker: DeletionExecutor;                      // the cross-aggregate revoke on delete
//     senders: Senders;                               // the delete confirmation email
//     maxUploadBytes?: number;                        // import upload cap (default large)
//   }
//
//   type ActionResult = { ok: true } | { ok: false; reason: string }
//   type ExportResult = { ok: true; document: ExportDocument } | { ok: false; reason: string }
//   type ImportResult = { ok: true } | { ok: false; reason: string }   // (+ an optional summary)
//
//   input shapes:
//     importData:     an uploaded file (a browser `File` from `formData.get("file")`;
//                     duck-typed, never `instanceof File` — that fails across server realms)
//     deleteAccount:  { confirmation: string }        // the typed confirmation phrase
//
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — NEVER a client-supplied value (CLAUDE.md member scope /
//     design §5). There is no userId on any input and the import IGNORES any id inside
//     the uploaded file, so a signed-in person can only export / import / delete for
//     THEMSELVES.
//   • exportData returns the export document ONLY when the session carries a step-up
//     completed within the last 5 minutes (requireStepUp); otherwise it refuses and
//     returns no document.
//   • deleteAccount requires BOTH a fresh step-up AND the exact typed confirmation phrase
//     before it invokes the deletion service; if either is missing it refuses and nothing
//     is deleted (the DEK is intact, nothing is revoked / enqueued / emailed).
//   • importData validates the uploaded export and restores it into the SIGNED-IN account;
//     import needs no step-up (it is not a disclosure of secrets, unlike export/delete).
//
// ─── Obligations (this task's cross-cutting invariants, as behaviour) ─────────────────
//   [obligation:validate-and-parameterize-input] (INV-102) — the import action rejects a
//     malformed (bad JSON / wrong-version) or oversized upload with a 4xx `HttpError`
//     BEFORE any write, persisting nothing; and a SQL-injection probe in an input field
//     travels as a BOUND value (never spliced into the SQL text), so the table survives.
//   [obligation:secrets-from-env] (INV-103) — the actions run purely from their injected
//     seams and read no `process.env`, so a decoy env secret never lands in the export
//     document, in restored/stored content, or in the delete confirmation email.
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`, so tests
// share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createDataActions, DELETE_ACCOUNT_CONFIRMATION } from "./actions";

import { createUser, getUserById } from "@/server/db/users";
import { createSession, recordStepUp, type Session } from "@/server/auth/session";
import { createMemory, listMemoriesForUser } from "@/server/db/memories";
import { listImportedEntriesForUser } from "@/server/db/imported-history";
import { listPendingPurges } from "@/server/db/account-purge";
import type { DeletionExecutor } from "@/server/account/delete";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createOutbox, type Outbox } from "@/server/notify/outbox";
import type { Senders } from "@/server/notify/senders";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db, QueryResult } from "@/server/db/index";
import type { ExportDocument } from "@/server/export/schema";

// --- the contract result types, declared here so the tests read cleanly (see header) ----

type ActionResult = { ok: true } | { ok: false; reason: string };
type ExportResult = { ok: true; document: ExportDocument } | { ok: false; reason: string };
type ImportResult = { ok: true } | { ok: false; reason: string };

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// A frozen instant every action reads time through: a session stepped up at T0, read by a
// clock also at T0, is comfortably inside the 5-minute step-up window, with no wall-clock
// dependence.
const T0 = new Date("2026-06-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);

// A clock six minutes past T0 — used to make a step-up stamped at T0 STALE (older than the
// 5-minute window), without any wall-clock dependence.
const SIX_MIN_LATER = new Date(T0.getTime() + 6 * 60 * 1000);
const staleClock: Clock = fixedClock(SIX_MIN_LATER);

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// The cross-aggregate revoke seam, observed through a spy that records the userId handed
// to it — so a test asserts the revocation was REQUESTED (and for whom) without a real
// agent/connection/credential store (mirrors the account-deletion service's own tests).
function makeRevokerSpy(): { revoker: DeletionExecutor; revoked: string[] } {
  const revoked: string[] = [];
  const revoker: DeletionExecutor = {
    async revokeAgentsAndConnections(userId: string): Promise<void> {
      revoked.push(userId);
    },
  };
  return { revoker, revoked };
}

// Build the data actions over the real seams. `senders` is a FRESH dev outbox standing in
// for every channel (exactly what the page wires in dev), so a test can read back the
// delete confirmation email; `revoker` is a spy. `clockOverride` lets a test age a
// step-up; `maxUploadBytes` lets a test cap the import upload for the oversized case.
function makeActions(
  db: Db,
  keyWrapper: KeyWrapper,
  opts: { clock?: Clock; maxUploadBytes?: number } = {},
): {
  actions: ReturnType<typeof createDataActions>;
  outbox: Outbox;
  revoked: string[];
} {
  const outbox = createOutbox();
  const senders: Senders = { push: outbox, email: outbox, sms: outbox };
  const { revoker, revoked } = makeRevokerSpy();
  const actions = createDataActions({
    db,
    clock: opts.clock ?? clock,
    keyWrapper,
    revoker,
    senders,
    ...(opts.maxUploadBytes !== undefined ? { maxUploadBytes: opts.maxUploadBytes } : {}),
  });
  return { actions, outbox, revoked };
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper` (the resolution path
// the actions use to read/write this person's DEK-encrypted content), returning their id
// and the raw DEK.
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

// A fresh session for `userId` that has NEVER stepped up (steppedUpAt === null) — the
// "no fresh step-up" case for the sensitive-action gate.
async function freshSession(db: Db, userId: string): Promise<Session> {
  return (await createSession(db, userId, { clock, random: systemRandom })).session;
}

// A session for `userId` carrying a step-up stamped at T0 by the real recordStepUp. Read
// by a clock at T0 it is FRESH (requireStepUp passes); read by `staleClock` it is STALE.
async function steppedUpSession(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  return recordStepUp(db, created.session.id, { clock });
}

// Seed one memory for `userId` (content DEK-encrypted at rest) so an export has something
// to carry and an ownership test has something to leak.
async function seedMemory(
  db: Db,
  userId: string,
  dek: Uint8Array,
  content: string,
): Promise<void> {
  await createMemory(db, { userId, content, sourceAgentId: null, scope: "shared" }, dek, clock);
}

// A complete, well-formed Warthog export document (the E16-S01 schema), as a plain object
// so a test can vary ONE section (a crafted memory / activity entry, or a wrong `version`)
// without any typing friction — the envelope is exercised through real schema validation,
// not the TS type. `overrides` is merged over the defaults.
function validExportDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    exportedAt: "2026-01-15T00:00:00.000Z",
    profile: { name: "Ada", email: "ada@warthog.com.au", fields: [] },
    preferences: {},
    skills: [],
    memory: [],
    rules: [],
    tasks: [],
    lifeAdmin: [],
    connections: [],
    activity: [],
    ...overrides,
  };
}

// Wrap a JSON-serialisable document as the browser upload the import action receives
// (`formData.get("file")` yields a `File`). The action duck-types it, so a real `File`
// with `.size` + `.text()` is exactly the production shape.
function uploadOf(document: unknown): File {
  return new File([JSON.stringify(document)], "export.json", { type: "application/json" });
}

// --- assertion helpers (mirrored from the sibling security/notifications action tests) --

function expectOk(r: ActionResult | ExportResult | ImportResult, label: string): void {
  if (!r.ok) assert.fail(`${label}: expected success, got refusal "${r.reason}"`);
}
function expectRefused(r: ActionResult | ExportResult | ImportResult, label: string): void {
  if (r.ok) assert.fail(`${label}: expected a refusal, got success`);
  assert.ok(r.reason.length > 0, `${label}: the refusal carries a plain reason`);
}

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

// A recording proxy over a real db: passes queries through while capturing (text, values),
// so "every value is bound, never spliced into the SQL text" is observable (INV-102). It
// exposes only `query`/`close` (no `transaction`), so `withTransaction` drives
// BEGIN/COMMIT through `query` and EVERY statement the import issues is captured.
interface RecordingProxy extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingProxy(real: Db): RecordingProxy {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close(): Promise<void> {
      return real.close();
    },
  };
}

// Whether a relation of this exact name exists on this handle (a non-throwing probe scoped
// to the one table under test — behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// =====================================================================================
// EXPORT — the document is returned ONLY after a fresh step-up (within the last 5
// minutes); it carries the session person's data and nobody else's.
// =====================================================================================

test("exportData returns the export document after a fresh step-up, carrying the session person's data", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    await seedMemory(db, alice.userId, alice.dek, "remember alice's reading list");
    const { actions } = makeActions(db, keyWrapper);

    const session = await steppedUpSession(db, alice.userId);
    const result: ExportResult = await actions.exportData(session);
    expectOk(result, "export with a fresh step-up");
    if (!result.ok) return;

    // A genuine export document to the versioned schema, carrying Alice's own content.
    assert.equal(result.document.version, 1, "the export document is the versioned export shape");
    assert.ok(
      (result.document.memory as Array<{ content?: string }>).some(
        (m) => m.content === "remember alice's reading list",
      ),
      "the export document carries the session person's memory",
    );
  } finally {
    await db.close();
  }
});

test("exportData without a fresh step-up is refused and returns no document", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const { actions } = makeActions(db, keyWrapper);

    const session = await freshSession(db, alice.userId); // never stepped up
    const result: ExportResult = await actions.exportData(session);

    expectRefused(result, "export without a step-up");
    assert.ok(!("document" in result && result.document), "a refused export returns no document");
  } finally {
    await db.close();
  }
});

test("exportData with a STALE step-up (older than 5 minutes) is refused", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    // The step-up is stamped at T0; the actions read time through a clock six minutes
    // later, so the step-up is outside the 5-minute window.
    const session = await steppedUpSession(db, alice.userId);
    const { actions } = makeActions(db, keyWrapper, { clock: staleClock });

    const result: ExportResult = await actions.exportData(session);
    expectRefused(result, "export with a stale step-up");
  } finally {
    await db.close();
  }
});

test("exportData carries only the session person's data — never another person's", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    await seedMemory(db, alice.userId, alice.dek, "alice-only-memory");
    await seedMemory(db, bob.userId, bob.dek, "bob-secret-memory");
    const { actions } = makeActions(db, keyWrapper);

    const result: ExportResult = await actions.exportData(await steppedUpSession(db, alice.userId));
    expectOk(result, "Alice's export");
    if (!result.ok) return;

    const serialised = JSON.stringify(result.document);
    assert.ok(serialised.includes("alice-only-memory"), "Alice's export carries her own memory");
    assert.ok(
      !serialised.includes("bob-secret-memory"),
      "Alice's export never carries another person's data (member scope — the id is the session's)",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// IMPORT — a valid uploaded export is validated and restored into the SIGNED-IN account.
// =====================================================================================

test("importData validates and restores an uploaded export into the signed-in account", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const { actions } = makeActions(db, keyWrapper);

    const upload = uploadOf(
      validExportDocument({
        memory: [{ content: "restored memory from a previous export", scope: "shared" }],
        activity: [{ seq: 1, occurredAt: "2026-02-02T00:00:00.000Z", kind: "tool_call", source: "warthog" }],
      }),
    );

    const result: ImportResult = await actions.importData(await freshSession(db, alice.userId), upload);
    expectOk(result, "import a valid export");

    // The memory is restored into Alice's live account (through the real store, so it
    // decrypts under her DEK)...
    const memories = await listMemoriesForUser(db, alice.userId, alice.dek);
    assert.ok(
      memories.some((m) => m.content === "restored memory from a previous export"),
      "the uploaded memory is restored into the signed-in account",
    );

    // ...and the old activity history lands in the READ-ONLY imported-history archive
    // (never the live hash-chained record).
    const archived = await listImportedEntriesForUser(db, alice.userId, alice.dek);
    assert.ok(archived.length >= 1, "the uploaded activity history is archived to imported history");
  } finally {
    await db.close();
  }
});

test("importData restores under the session user and IGNORES any id in the uploaded file", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const { actions } = makeActions(db, keyWrapper);

    // The file carries a forged id on its memory — the restore must ignore it (each store
    // generates its own row id for the SESSION user), never steer a write by a client id.
    const FORGED = "11111111-2222-3333-4444-555555555555";
    const upload = uploadOf(
      validExportDocument({
        memory: [{ id: FORGED, content: "owned by the session user, not the file", scope: "shared" }],
      }),
    );

    expectOk(await actions.importData(await freshSession(db, alice.userId), upload), "Alice imports");

    // Restored under Alice, with a FRESH id (not the forged one).
    const aliceMemories = await listMemoriesForUser(db, alice.userId, alice.dek);
    const restored = aliceMemories.find((m) => m.content === "owned by the session user, not the file");
    assert.ok(restored, "the memory is restored into the signed-in account");
    assert.notEqual(restored!.id, FORGED, "the id in the file is ignored — the store generates a fresh id");

    // Nothing landed under Bob — there is no client id that can steer a write onto him.
    assert.equal(
      (await listMemoriesForUser(db, bob.userId, bob.dek)).length,
      0,
      "the import never writes to another person's account",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a malformed / wrong-version / oversized
// upload is rejected at the validation boundary with a 4xx HttpError, BEFORE any write,
// and nothing is restored.
// =====================================================================================

test("importData rejects a malformed or oversized upload with a 4xx, restoring nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    // A tiny upload cap, so an oversized upload is rejected by size before it is parsed.
    const { actions } = makeActions(db, keyWrapper, { maxUploadBytes: 1024 });
    const session = await freshSession(db, alice.userId);

    // Malformed JSON — rejected before any write.
    await assertRejects4xx("import malformed JSON", () =>
      actions.importData(session, new File(["{ not valid json"], "bad.json")),
    );

    // A well-formed JSON that is the WRONG version — rejected by the schema.
    await assertRejects4xx("import wrong-version document", () =>
      actions.importData(session, uploadOf(validExportDocument({ version: 2 }))),
    );

    // An oversized upload — rejected by size (over the 1 KiB cap) before parsing.
    await assertRejects4xx("import oversized upload", () =>
      actions.importData(session, new File(["x".repeat(4096)], "big.json")),
    );

    // Nothing was restored by any rejected call.
    assert.equal(
      (await listMemoriesForUser(db, alice.userId, alice.dek)).length,
      0,
      "a rejected import restores no memory",
    );
    assert.equal(
      (await listImportedEntriesForUser(db, alice.userId, alice.dek)).length,
      0,
      "a rejected import archives nothing",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a SQL-injection probe in an input field
// cannot alter a query: every value the import issues travels BOUND (never spliced into
// the SQL text), and the table is not dropped. Proven with a recording proxy over a real
// db that passes queries through while capturing text + values.
// =====================================================================================

test("a SQL-injection probe in an import field is bound, not spliced, and cannot alter a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const proxy = recordingProxy(db);
    // The actions must bind through whichever db they are given — here, the recorder.
    const outbox = createOutbox();
    const senders: Senders = { push: outbox, email: outbox, sms: outbox };
    const { revoker } = makeRevokerSpy();
    const actions = createDataActions({ db: proxy, clock, keyWrapper, revoker, senders });

    // The probe rides on an archived activity entry's `kind` — a plaintext metadata column
    // of imported_history — so it reaches the query layer as a value (unlike encrypted
    // content). A clean field pins the binding; the probe then proves the table survives.
    const PROBE = "'); DROP TABLE imported_history; --";
    const upload = uploadOf(
      validExportDocument({
        activity: [{ seq: 1, occurredAt: "2026-03-03T00:00:00.000Z", kind: PROBE, source: "warthog" }],
      }),
    );

    expectOk(await actions.importData(await freshSession(db, alice.userId), upload), "import with a probe field");

    // The probe travelled as a BOUND value, never concatenated into any SQL text, and no
    // injected statement ever appears in a query's text.
    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(allValues.includes(PROBE), "the probe field travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes(PROBE), "the probe is never spliced into the SQL text");
      assert.ok(!/\bDROP\s+TABLE\b/i.test(call.text), "no injected statement appears in the SQL text");
    }

    // The table survives, and the archived entry kept the probe verbatim as DATA.
    assert.equal(await tableExists(db, "imported_history"), true, "the imported_history table survives the probe");
    const archived = await listImportedEntriesForUser(db, alice.userId, alice.dek);
    assert.ok(
      archived.some((e) => e.kind === PROBE),
      "the probe was stored as inert data, not executed",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// DELETE — requires BOTH a fresh step-up AND the typed confirmation phrase, then invokes
// the deletion service (crypto-shred + revoke + enqueue + confirm).
// =====================================================================================

test("deleteAccount with a fresh step-up AND the confirmation phrase deletes the session account", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const before = await getUserById(db, alice.userId);
    const originalDek = before!.wrappedDek;
    const { actions, outbox, revoked } = makeActions(db, keyWrapper);

    const session = await steppedUpSession(db, alice.userId);
    const result: ActionResult = await actions.deleteAccount(session, {
      confirmation: DELETE_ACCOUNT_CONFIRMATION,
    });
    expectOk(result, "delete with step-up + confirmation");

    // The deletion service ran: the wrapped DEK is crypto-shredded, the revoke was
    // requested once for this person, the account is enqueued for purge, and a
    // confirmation email went out.
    const after = await getUserById(db, alice.userId);
    assert.ok(after, "the users row persists until the purge job removes it");
    assert.notEqual(after!.wrappedDek, originalDek, "the wrapped DEK is crypto-shredded");
    assert.deepEqual(revoked, [alice.userId], "the person's agents and connections are revoked exactly once");
    assert.equal(
      (await listPendingPurges(db)).filter((e) => e.userId === alice.userId).length,
      1,
      "the account is enqueued for purge",
    );
    assert.equal(
      outbox.list().filter((m) => m.channel === "email").length,
      1,
      "a confirmation email is sent",
    );
  } finally {
    await db.close();
  }
});

test("deleteAccount without a fresh step-up is refused and nothing is deleted", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const originalDek = (await getUserById(db, alice.userId))!.wrappedDek;
    const { actions, outbox, revoked } = makeActions(db, keyWrapper);

    // Correct confirmation, but the session has never stepped up.
    const session = await freshSession(db, alice.userId);
    const result: ActionResult = await actions.deleteAccount(session, {
      confirmation: DELETE_ACCOUNT_CONFIRMATION,
    });
    expectRefused(result, "delete without a step-up");

    // Nothing was done: the DEK is intact, nothing revoked / enqueued / emailed.
    assert.equal((await getUserById(db, alice.userId))!.wrappedDek, originalDek, "the wrapped DEK is intact");
    assert.deepEqual(revoked, [], "no revoke was requested");
    assert.equal(
      (await listPendingPurges(db)).filter((e) => e.userId === alice.userId).length,
      0,
      "the account is never enqueued for purge",
    );
    assert.equal(outbox.list().filter((m) => m.channel === "email").length, 0, "no confirmation email is sent");
  } finally {
    await db.close();
  }
});

test("deleteAccount without the exact confirmation phrase is refused and nothing is deleted", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const originalDek = (await getUserById(db, alice.userId))!.wrappedDek;
    const { actions, outbox, revoked } = makeActions(db, keyWrapper);

    // Fully stepped up, so the confirmation is the only thing standing in the way. An empty
    // and a wrong-but-bounded phrase are both refused.
    for (const confirmation of ["", "delete"]) {
      const session = await steppedUpSession(db, alice.userId);
      expectRefused(
        await actions.deleteAccount(session, { confirmation }),
        `delete with confirmation ${JSON.stringify(confirmation)}`,
      );
    }

    assert.equal((await getUserById(db, alice.userId))!.wrappedDek, originalDek, "the wrapped DEK is intact");
    assert.deepEqual(revoked, [], "no revoke was requested for an unconfirmed delete");
    assert.equal(
      (await listPendingPurges(db)).filter((e) => e.userId === alice.userId).length,
      0,
      "an unconfirmed delete enqueues nothing",
    );
    assert.equal(outbox.list().filter((m) => m.channel === "email").length, 0, "an unconfirmed delete sends no email");
  } finally {
    await db.close();
  }
});

test("deleteAccount acts only on the session account — another person's account is untouched", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const bobDek = (await getUserById(db, bob.userId))!.wrappedDek;
    const { actions, revoked } = makeActions(db, keyWrapper);

    // Alice deletes her OWN account (the id is the session's, never a client value).
    expectOk(
      await actions.deleteAccount(await steppedUpSession(db, alice.userId), {
        confirmation: DELETE_ACCOUNT_CONFIRMATION,
      }),
      "Alice deletes her own account",
    );

    // Bob is wholly untouched: his DEK is intact, he is not enqueued, his agents not revoked.
    assert.equal((await getUserById(db, bob.userId))!.wrappedDek, bobDek, "Bob's wrapped DEK is untouched");
    assert.equal(
      (await listPendingPurges(db)).filter((e) => e.userId === bob.userId).length,
      0,
      "Bob is never enqueued for purge by Alice's deletion",
    );
    assert.deepEqual(revoked, [alice.userId], "only Alice's agents and connections are revoked");
  } finally {
    await db.close();
  }
});

test("deleteAccount rejects an oversized confirmation and deletes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const originalDek = (await getUserById(db, alice.userId))!.wrappedDek;
    const { actions, revoked } = makeActions(db, keyWrapper);
    const session = await steppedUpSession(db, alice.userId);

    // An absurd confirmation value is rejected — EITHER a 4xx at the boundary OR a
    // refusal — and in neither case is anything deleted.
    try {
      const result = await actions.deleteAccount(session, { confirmation: "a".repeat(10_000) });
      assert.equal(result.ok, false, "an oversized confirmation must not delete the account");
    } catch (err) {
      assert.ok(
        err instanceof HttpError && err.status >= 400 && err.status < 500,
        `an oversized confirmation must be a 4xx HttpError or a refusal, got ${String(err)}`,
      );
    }

    assert.equal((await getUserById(db, alice.userId))!.wrappedDek, originalDek, "the wrapped DEK is intact");
    assert.deepEqual(revoked, [], "no revoke was requested");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:secrets-from-env] — the actions run purely from their injected seams and
// read no `process.env`: a decoy secret planted in the environment never appears in the
// export document, in restored/stored content, or in the delete confirmation email.
// =====================================================================================

test("the actions read no process.env: a decoy env secret never appears in an export, stored content, or a message", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_data";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    await seedMemory(db, alice.userId, alice.dek, "a plain memory");
    const { actions, outbox } = makeActions(db, keyWrapper);

    // Export (stepped up), import a small document, then delete — the whole surface.
    const exported = await actions.exportData(await steppedUpSession(db, alice.userId));
    expectOk(exported, "export for the decoy check");
    assert.ok(exported.ok && !JSON.stringify(exported.document).includes(DECOY), "no env value folds into the export");

    const importResult = await actions.importData(
      await freshSession(db, alice.userId),
      uploadOf(validExportDocument({ memory: [{ content: "imported plain memory", scope: "shared" }] })),
    );
    expectOk(importResult, "import for the decoy check");

    expectOk(
      await actions.deleteAccount(await steppedUpSession(db, alice.userId), { confirmation: DELETE_ACCOUNT_CONFIRMATION }),
      "delete for the decoy check",
    );

    // Nothing the actions stored or delivered carries the decoy.
    const stored = {
      memories: await listMemoriesForUser(db, alice.userId, alice.dek),
      archived: await listImportedEntriesForUser(db, alice.userId, alice.dek),
      outbox: outbox.list(),
    };
    assert.ok(
      !JSON.stringify(stored).includes(DECOY),
      "no ambient env value is folded into stored content or a delivered message",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
