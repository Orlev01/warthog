// E14-S13 — Life-admin page loader + actions
// (`src/app/(portal)/(protected)/life-admin/actions.ts`, mounted by the thin
// `life-admin/page.tsx`).
//
// RED-first: the life-admin page-actions seam does NOT exist yet, so importing
// `./actions` throws (ERR_MODULE_NOT_FOUND) and `tsc --noEmit` reddens on the
// missing module — every test here fails until the builder writes it. That absence
// IS the point of test-first; do NOT implement anything to make these pass. The
// builder writes `actions.ts` afterwards to satisfy exactly this contract and wires
// the thin `page.tsx` over it.
//
// Where the task names an entry/page file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `skills/actions.ts`, `vault/actions.ts`, `connectors/actions.ts`,
// `settings/security/actions.ts` do) — NEVER on the thin `page.tsx`, which may export
// only its framework fields (`next build` rejects any other export, OBS-025). These
// tests drive that factory directly with REAL seams; the page mounts a thin loader +
// `"use server"` wrappers over it. A server PAGE that reads the session cookie +
// database cannot be rendered without a live request scope, so — exactly like the
// sibling skills / vault / activity loader tests — the loader's data assembly is pinned
// on the factory's `load`, and the SCREENS it mounts are pinned by feeding `load`'s
// output straight into the already-render-tested <LifeAdminView/> (E14-S11) and
// <TasksView/> (E14-S12).
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the views it mounts; what each
// mutation CHANGES in the database; what each one REFUSES) against an isolated in-memory
// PGlite with the REAL migrations (src/test/db) and the REAL already-built seams the
// actions compose — the life-admin records store (`db/life-admin-records`, E14-S08), the
// tasks store (`db/tasks`, E14-S04/07), the moving-checklist store (`db/moving-checklist`,
// E14-S05), the encrypted receipt-file store (`storage/receipt-files`, E14-S03), the
// moving-checklist builder (`moving/checklist`, E14-S06), the agents store (`db/agents`)
// and the two render-tested views. No test asserts on the source text of any module, so a
// later behaviour-preserving refactor (a rename, a moved import) stays green.
//
// WHY this exists (task E14-S13; brief "Life admin" / "Tasks and hand-offs" /
// "Moving-house helper"; design §4.1; CLAUDE.md). The Life Admin triad reads the person's
// records, moving checklist and tasks server-side and mounts the record, checklist and
// task controls; this is where a receipt file is attached (encrypted on the server), the
// moving checklist is (re)built, and a checklist item is handed to an agent as a task.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createLifeAdminActions(deps: {
//     db: Db;                 // the parameterizing database seam
//     keyWrapper: KeyWrapper; // unwraps the session person's own DEK (users.wrapped_dek)
//     clock: Clock;           // supplies `now` to the moving-checklist builder (never SQL now())
//     blob: BlobStore;        // the private blob seam the receipt-file store puts ciphertext into
//   }): {
//     // ALL of the session person's records (grouped by kind, fields DECRYPTED), moving
//     // checklist items and tasks (titles/notes decrypted, assignee + note authors resolved
//     // to agent display names), plus the person's agents — shaped into the props
//     // <LifeAdminView/> and <TasksView/> are mounted over. Member-scoped by session.userId.
//     load(session): Promise<{ subscriptions; receipts; renewals; checklist; tasks; agents }>
//
//     // records
//     saveRecord(session, { kind; fields; dueDate?; status?; reminderOffsets? }): Promise<Result>
//     updateRecord(session, { id; fields; dueDate?; status?; reminderOffsets? }): Promise<Result>
//     attachReceiptFile(session, { recordId; file }): Promise<Result>  // DUCK-TYPES the upload
//     setRecordReminders(session, { id; reminderOffsets }): Promise<Result>
//
//     // moving checklist
//     toggleChecklistItem(session, { id }): Promise<Result>
//     handChecklistItemToAgent(session, { id; agentId? }): Promise<Result>  // creates+links a task
//     refreshMovingChecklist(session): Promise<Result>
//
//     // tasks
//     createTask(session, { title; assignee? }): Promise<Result>
//     updateTask(session, { id; title; assignee; status }): Promise<Result>
//     completeTask(session, { id }): Promise<Result>
//     assignTask(session, { id; assignee }): Promise<Result>
//     addTaskNote(session, { id; text }): Promise<Result>
//   }
//
//   Result = { ok: true } | { ok: false; reason: string }   // never a silent success
//
//   • every read/write is member-scoped by session.userId (the project rule + INV-102):
//     another person's records / tasks / checklist are never read, changed or removed by id.
//   • attachReceiptFile DUCK-TYPES the upload (`typeof name === "string" && typeof size ===
//     "number"`, NEVER `instanceof File` — OBS-052: instanceof fails across server realms)
//     and stores ONLY DEK-encrypted ciphertext via the receipt-file store (the plaintext
//     bytes never land in the blob).
//   • handChecklistItemToAgent creates a task (assigned to the named own agent, or 'any')
//     and LINKS it to the item (the item's linkedTaskId points at the new task).
//   • input is validated at the boundary (zod → a 4xx HttpError) BEFORE anything is written,
//     so malformed / oversized input writes nothing (INV-102). A malformed id is rejected
//     as a 4xx BEFORE it can reach `WHERE id = $1` as a cast (OBS-049). Every value reaches
//     storage bound as a query parameter (content additionally DEK-encrypted), so a value
//     shaped like SQL is stored as data and cannot alter a query.
//   • the module reads no process.env and holds no secret (INV-103): db, keyWrapper, clock
//     and blob are INJECTED seams, so no ambient env value lands in any output.
//
// ─── NOTE on the acceptance-criterion wording vs. this codebase ──────────────────────
// AC says "a record, task or checklist id that is not a positive INTEGER is rejected with
// a 4xx". That phrasing is generic obligation boilerplate (serial catalogue ids); in
// Warthog these ids are `uuid`s (life_admin_records / tasks / moving_checklist all
// `gen_random_uuid()`), and the sibling stores/actions validate ids with `z.uuid()`. The
// obligation is OBS-049 / validate-and-parameterize-input: a MALFORMED id is rejected at
// the boundary with a 4xx before it can reach `WHERE id = $1` as a cast. We honour it
// using the ACTUAL id shape — and the malformed probes below include a bare integer, a
// negative, a decimal and the empty string, so "not a positive integer is rejected" holds
// true as a special case of "not a well-formed uuid is rejected".
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's records/checklist/tasks and mounts
//        LifeAdminView + TasksView over them, with every action wired.
//   AC2  attachReceiptFile duck-types the upload (never instanceof File) and stores only
//        DEK-encrypted ciphertext; handChecklistItemToAgent creates a task assigned to
//        that agent and links it to the item.
//   AC3  a non-positive-integer (malformed) id is a 4xx (not a raw cast), and a signed-in
//        user cannot read or change another user's records/tasks/checklist by id.
//   AC4  a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
//        probe in an input field cannot alter a query.  [validate-and-parameterize-input]
//   AC5  no secret value lands in source / client bundle / build context; config from env.
//        [secrets-from-env]
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb(). The signed-in person is a REAL user row (every member table's
// user_id is a foreign key to users(id)) whose stored wrapped DEK really unwraps under the
// test KeyWrapper, so content round-trips decrypted. We render the views with
// `react-dom/server` (no DOM/jsdom — React component / E2E testing is a per-job ADR),
// exactly as the sibling view + loader tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createLifeAdminActions } from "./actions";

import { LifeAdminView } from "@/components/life-admin/life-admin-view";
import { TasksView } from "@/components/life-admin/tasks-view";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import {
  createRecord as seedRecord,
  listRecordsForUser,
} from "@/server/db/life-admin-records";
import {
  createTask as seedTask,
  addNote as seedNote,
  listTasksForUser,
} from "@/server/db/tasks";
import {
  addOwnItem as seedChecklistItem,
  listForUser as listChecklist,
} from "@/server/db/moving-checklist";
import { saveIdentityField } from "@/server/db/identity-fields";
import { createConnection } from "@/server/db/connections";
import { getReceiptFile } from "@/server/storage/receipt-files";
import { createInMemoryBlobStore, type BlobStore } from "@/server/storage/blob";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, systemClock, type Clock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper

// A frozen "now" for the moving-checklist resolution; the move date below is AFTER it, so
// a move set up with MOVE_DATE is unambiguously still ahead (now < movingDate).
const NOW = new Date("2026-11-07T00:00:00.000Z");
const MOVE_DATE = "2027-03-01";

// A real local KeyWrapper (dev/test), exactly the one a non-production composition root
// selects — so wrap/unwrap is genuine, not a stub.
function makeKeyWrapper(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so content saved by the actions round-trips decrypted through the
// stores, and the loader can decrypt what it reads back. Emails are uniquified so
// parallel test files never collide on users.email UNIQUE.
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

// Give `userId` one of their OWN agents and return its id + name, so a task can be
// assigned to / handed to it and the loader can resolve its display name.
async function makeAgent(
  db: Db,
  userId: string,
  name: string,
): Promise<{ agentId: string; name: string }> {
  const agent = await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName: name, platform: "claude" },
    systemClock,
  );
  return { agentId: agent.id, name };
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Build the life-admin actions under test with the real db + keyWrapper + clock + blob
// seams. The blob defaults to a FRESH in-memory store (so the attach test can inspect the
// stored ciphertext); the clock is frozen at NOW for the moving-checklist builder.
function makeActions(
  db: Db,
  keyWrapper: KeyWrapper,
  opts: { clock?: Clock; blob?: BlobStore } = {},
) {
  return createLifeAdminActions({
    db,
    keyWrapper,
    clock: opts.clock ?? fixedClock(NOW),
    blob: opts.blob ?? createInMemoryBlobStore(),
  });
}

// A DUCK-TYPED upload that is NOT a `File` instance: a plain object carrying only the
// `name` / `size` / `type` / `arrayBuffer()` shape a server action must accept (OBS-052 —
// `instanceof File` fails across the undici/global realm split, so the action must
// feature-detect, never `instanceof`). If the implementation used `instanceof File` this
// would be rejected; accepting it proves the duck-typing.
function fakeUpload(name: string, bytes: Uint8Array, type = "application/pdf") {
  return {
    name,
    size: bytes.length,
    type,
    async arrayBuffer(): Promise<ArrayBuffer> {
      const copy = new Uint8Array(bytes); // a fresh, exactly-sized buffer
      return copy.buffer;
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
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

type Actions = ReturnType<typeof createLifeAdminActions>;
type ActionResult = Awaited<ReturnType<Actions["saveRecord"]>>;

// The second-parameter (input) type of a two-arg method, inferred from the factory.
type In<K extends keyof Actions> = Actions[K] extends (s: Session, i: infer I) => unknown ? I : never;

// Cast a loose object (what an untrusted form body could carry) to a method's input type,
// so a test can pass a partial, a malformed value, or a smuggled rogue key without a type
// error — exactly what an untrusted body could carry.
const as = <K extends keyof Actions>(o: Record<string, unknown>): In<K> =>
  o as unknown as In<K>;

const okOf = (r: unknown): boolean => (r as { ok: boolean }).ok;

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

// Assert a mutation is REFUSED — either a thrown 4xx HttpError or a reported { ok: false }
// refusal, never a silent success and never an uncontrolled 500. (An ownership refusal
// that depends on stored state may legitimately be reported rather than thrown; this
// accepts both, but a thrown plain Error — a raw 500 — fails.)
async function assertRejected(label: string, fn: () => Promise<ActionResult>): Promise<void> {
  let result: ActionResult | undefined;
  try {
    result = await fn();
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a thrown rejection must be a 4xx HttpError (not a raw 500), got ${String(err)}`,
    );
    return;
  }
  assert.equal(
    okOf(result),
    false,
    `${label}: the mutation must be refused (ok:false), not a silent success`,
  );
}

// Set up a move for `userId`: a settled postal address (no moving-on date) and an upcoming
// one carrying MOVE_DATE — the "new address with a moving date" the brief describes. Seeded
// under the SAME dek the actions will unwrap, so the builder can decrypt and resolve it.
async function setUpMove(db: Db, userId: string, dek: Uint8Array): Promise<void> {
  await saveIdentityField(
    db,
    { userId, kind: "postal_address", value: JSON.stringify({ line1: "12 Old St" }), movingOn: null },
    dek,
  );
  await saveIdentityField(
    db,
    { userId, kind: "postal_address", value: JSON.stringify({ line1: "99 New Rd" }), movingOn: MOVE_DATE },
    dek,
  );
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's records/checklist/tasks and mounts
// LifeAdminView + TasksView over them.
// =====================================================================================

test("the loader returns the session user's records, checklist and tasks and mounts both views", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "loader-ok");
    const agent = await makeAgent(db, userId, "My Claude");

    // One record per kind (fields DEK-encrypted by the store), a checklist item, and a
    // task assigned to the person's own agent carrying an agent-authored note.
    await seedRecord(
      db,
      { userId, kind: "subscription", fields: { service: "Netflix" }, dueDate: "2027-01-01", status: "active", source: { kind: "person" } },
      dek,
    );
    await seedRecord(
      db,
      { userId, kind: "receipt_warranty", fields: { merchant: "JB Hi-Fi" }, status: "kept", source: { kind: "person" } },
      dek,
    );
    await seedRecord(
      db,
      { userId, kind: "renewal_appointment", fields: { what: "Passport renewal" }, dueDate: "2027-02-01", status: "scheduled", source: { kind: "person" } },
      dek,
    );
    await seedChecklistItem(db, { userId, label: "Tell the bank" }, dek);
    const task = await seedTask(
      db,
      { userId, title: "Cancel the gym", assignee: agent.agentId, createdBy: { kind: "person" } },
      dek,
    );
    await seedNote(
      db,
      { userId, id: task.id, author: { kind: "agent", agentId: agent.agentId }, text: "Rang them, on hold" },
      dek,
    );

    const data = await makeActions(db, keyWrapper).load(sessionFor(userId));

    // The owner's agent is handed back for the assignee picker.
    assert.ok(
      data.agents.some((a: { name?: string }) => a.name === "My Claude"),
      `the loader returns the owner's agents; got ${JSON.stringify(data.agents)}`,
    );

    // "mounts LifeAdminView": feeding the loader's grouped records + checklist straight
    // into the already-render-tested view renders the owner's screen. Each tab is checked
    // via initialTab (only the active tab's panel renders).
    const subsText = strip(
      renderToStaticMarkup(
        <LifeAdminView
          subscriptions={data.subscriptions}
          receipts={data.receipts}
          renewals={data.renewals}
          checklist={data.checklist}
          initialTab="subscriptions"
        />,
      ),
    );
    assert.ok(subsText.includes("Netflix"), "mounting LifeAdminView renders the owner's subscription");

    const checklistText = strip(
      renderToStaticMarkup(
        <LifeAdminView
          subscriptions={data.subscriptions}
          receipts={data.receipts}
          renewals={data.renewals}
          checklist={data.checklist}
          initialTab="checklist"
        />,
      ),
    );
    assert.ok(checklistText.includes("Tell the bank"), "the owner's checklist item renders on the checklist tab");

    // "mounts TasksView": the loader resolves the assignee + note author to the agent's
    // display name, which the view renders as "Assigned to <name>" / "Reported by <name>".
    const tasksText = strip(
      renderToStaticMarkup(<TasksView tasks={data.tasks} agents={data.agents} />),
    );
    assert.ok(tasksText.includes("Cancel the gym"), "mounting TasksView renders the owner's task title");
    assert.ok(tasksText.includes("Rang them, on hold"), "the task's note renders");
    assert.ok(tasksText.includes("My Claude"), "the assignee / note author is resolved to the agent's display name");
  } finally {
    await db.close();
  }
});

test("the loader returns empty collections for a person who has saved nothing; the views still render", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "loader-empty");

    const data = await makeActions(db, keyWrapper).load(sessionFor(userId));

    assert.deepEqual(data.subscriptions, [], "no subscriptions");
    assert.deepEqual(data.receipts, [], "no receipts");
    assert.deepEqual(data.renewals, [], "no renewals");
    assert.deepEqual(data.checklist, [], "no checklist items");
    assert.deepEqual(data.tasks, [], "no tasks");

    // The screens still render (the Add / Create controls, the empty states) with no data.
    const lifeText = strip(
      renderToStaticMarkup(
        <LifeAdminView
          subscriptions={data.subscriptions}
          receipts={data.receipts}
          renewals={data.renewals}
          checklist={data.checklist}
        />,
      ),
    );
    assert.ok(lifeText.length > 0, "the empty Life Admin screen still renders");
    const tasksText = strip(renderToStaticMarkup(<TasksView tasks={data.tasks} agents={data.agents} />));
    assert.ok(tasksText.length > 0, "the empty Tasks screen still renders");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Records — saveRecord / updateRecord / setRecordReminders round-trip through the store
// and the loader, decrypted under the owner's DEK.
// =====================================================================================

test("saveRecord persists a record the loader reads back; updateRecord edits it; setRecordReminders changes only the reminder offsets", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "record-roundtrip");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const saved = await actions.saveRecord(
      session,
      as<"saveRecord">({ kind: "subscription", fields: { service: "Spotify" }, dueDate: "2027-05-01", status: "active" }),
    );
    assert.equal(okOf(saved), true, "saveRecord succeeds for the session user");

    // It round-trips decrypted through the store.
    const afterSave = await listRecordsForUser(db, userId, dek);
    const stored = afterSave.find((r) => (r.fields as { service?: string }).service === "Spotify");
    assert.ok(stored != null, "the saved record round-trips decrypted");

    // updateRecord replaces the owned record's fields.
    const updated = await actions.updateRecord(
      session,
      as<"updateRecord">({ id: stored!.id, fields: { service: "Spotify Family" }, status: "active" }),
    );
    assert.equal(okOf(updated), true, "updateRecord succeeds");
    const afterUpdate = (await listRecordsForUser(db, userId, dek)).find((r) => r.id === stored!.id);
    assert.equal(
      (afterUpdate!.fields as { service?: string }).service,
      "Spotify Family",
      "updateRecord changed the record's fields",
    );

    // setRecordReminders changes ONLY the reminder offsets, leaving the fields intact.
    const reminded = await actions.setRecordReminders(
      session,
      as<"setRecordReminders">({ id: stored!.id, reminderOffsets: [30, 7] }),
    );
    assert.equal(okOf(reminded), true, "setRecordReminders succeeds");
    const afterReminders = (await listRecordsForUser(db, userId, dek)).find((r) => r.id === stored!.id);
    assert.deepEqual(afterReminders!.reminderOffsets, [30, 7], "the reminder offsets were changed");
    assert.equal(
      (afterReminders!.fields as { service?: string }).service,
      "Spotify Family",
      "setRecordReminders left the record's fields untouched",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Tasks — create / assign / add-note / complete / update lifecycle, read back via the
// store (titles + notes decrypted) and the loader (assignee + author resolved).
// =====================================================================================

test("createTask opens a task; assignTask reassigns it; addTaskNote appends a note; completeTask marks it done", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "task-lifecycle");
    const agent = await makeAgent(db, userId, "My Claude");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const created = await actions.createTask(session, as<"createTask">({ title: "Book a plumber" }));
    assert.equal(okOf(created), true, "createTask succeeds");
    let task = (await listTasksForUser(db, userId, dek)).find((t) => t.title === "Book a plumber");
    assert.ok(task != null, "the created task round-trips decrypted");
    assert.equal(task!.status, "open", "a fresh task is open");
    assert.equal(task!.assignee, "any", "a task created with no assignee defaults to 'any'");

    // Reassign to the person's own agent.
    const assigned = await actions.assignTask(session, as<"assignTask">({ id: task!.id, assignee: agent.agentId }));
    assert.equal(okOf(assigned), true, "assignTask succeeds");
    task = (await listTasksForUser(db, userId, dek)).find((t) => t.id === task!.id);
    assert.equal(task!.assignee, agent.agentId, "the task is now assigned to the person's agent");

    // Append a person-authored note.
    const noted = await actions.addTaskNote(session, as<"addTaskNote">({ id: task!.id, text: "Before Friday please" }));
    assert.equal(okOf(noted), true, "addTaskNote succeeds");
    task = (await listTasksForUser(db, userId, dek)).find((t) => t.id === task!.id);
    assert.ok(
      task!.notes.some((n) => n.text === "Before Friday please" && n.author.kind === "person"),
      "the note is appended, authored by the person",
    );

    // Complete it.
    const done = await actions.completeTask(session, as<"completeTask">({ id: task!.id }));
    assert.equal(okOf(done), true, "completeTask succeeds");
    task = (await listTasksForUser(db, userId, dek)).find((t) => t.id === task!.id);
    assert.equal(task!.status, "done", "the task is marked done");
  } finally {
    await db.close();
  }
});

test("updateTask changes a task's title, assignee and status together", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "task-update");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const seeded = await seedTask(
      db,
      { userId, title: "Old title", assignee: "any", createdBy: { kind: "person" } },
      dek,
    );

    const result = await actions.updateTask(
      session,
      as<"updateTask">({ id: seeded.id, title: "New title", assignee: "any", status: "in_progress" }),
    );
    assert.equal(okOf(result), true, "updateTask succeeds");

    const after = (await listTasksForUser(db, userId, dek)).find((t) => t.id === seeded.id);
    assert.equal(after!.title, "New title", "the title was changed");
    assert.equal(after!.status, "in_progress", "the status was changed");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Moving checklist — toggle, hand-to-agent (creates + links a task), refresh (builds).
// =====================================================================================

test("toggleChecklistItem flips an owned item's done flag", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "checklist-toggle");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const item = await seedChecklistItem(db, { userId, label: "Redirect mail" }, dek);
    assert.equal(item.done, false, "precondition: a fresh item is not done");

    const on = await actions.toggleChecklistItem(session, as<"toggleChecklistItem">({ id: item.id }));
    assert.equal(okOf(on), true, "toggling succeeds");
    assert.equal(
      (await listChecklist(db, userId, dek)).find((i) => i.id === item.id)!.done,
      true,
      "the item is now done",
    );

    const off = await actions.toggleChecklistItem(session, as<"toggleChecklistItem">({ id: item.id }));
    assert.equal(okOf(off), true, "toggling back succeeds");
    assert.equal(
      (await listChecklist(db, userId, dek)).find((i) => i.id === item.id)!.done,
      false,
      "the item is not done again",
    );
  } finally {
    await db.close();
  }
});

test("handChecklistItemToAgent creates a task assigned to that agent and links it to the item (AC2)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "hand-own");
    const agent = await makeAgent(db, userId, "My Claude");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const item = await seedChecklistItem(db, { userId, label: "Tell the insurer" }, dek);

    const handed = await actions.handChecklistItemToAgent(
      session,
      as<"handChecklistItemToAgent">({ id: item.id, agentId: agent.agentId }),
    );
    assert.equal(okOf(handed), true, "the hand-off succeeds for the person's own agent");

    // The item is now linked to a task…
    const linkedItem = (await listChecklist(db, userId, dek)).find((i) => i.id === item.id);
    assert.ok(linkedItem != null, "the item still exists");
    assert.ok(linkedItem!.linkedTaskId != null, "the item is now linked to a task");

    // …and that task exists, assigned to THAT agent.
    const linkedTask = (await listTasksForUser(db, userId, dek)).find((t) => t.id === linkedItem!.linkedTaskId);
    assert.ok(linkedTask != null, "the linked task exists");
    assert.equal(linkedTask!.assignee, agent.agentId, "the created task is assigned to that agent");
  } finally {
    await db.close();
  }
});

test("handChecklistItemToAgent with no named agent hands it to any agent and still links a task (the view's hand-off path)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "hand-any");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const item = await seedChecklistItem(db, { userId, label: "Update the council" }, dek);

    const handed = await actions.handChecklistItemToAgent(
      session,
      as<"handChecklistItemToAgent">({ id: item.id }),
    );
    assert.equal(okOf(handed), true, "the hand-off succeeds with no named agent");

    const linkedItem = (await listChecklist(db, userId, dek)).find((i) => i.id === item.id);
    assert.ok(linkedItem!.linkedTaskId != null, "the item is linked to a task");
    const linkedTask = (await listTasksForUser(db, userId, dek)).find((t) => t.id === linkedItem!.linkedTaskId);
    assert.ok(linkedTask != null, "the linked task exists");
    assert.equal(linkedTask!.assignee, "any", "with no named agent the task is for any agent");
  } finally {
    await db.close();
  }
});

test("handChecklistItemToAgent refuses a foreign or nonexistent agent and links nothing", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "hand-foreign");
    const other = await makeUserWithDek(db, keyWrapper, "hand-other");
    const othersAgent = await makeAgent(db, other.userId, "Not mine");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const item = await seedChecklistItem(db, { userId, label: "Tell the vet" }, dek);

    // Another person's real agent id — well-formed, but NOT the session user's.
    await assertRejected("handChecklistItemToAgent(→ another person's agent)", () =>
      actions.handChecklistItemToAgent(session, as<"handChecklistItemToAgent">({ id: item.id, agentId: othersAgent.agentId })),
    );
    // A syntactically valid uuid that is nobody's agent.
    await assertRejected("handChecklistItemToAgent(→ nonexistent agent)", () =>
      actions.handChecklistItemToAgent(session, as<"handChecklistItemToAgent">({ id: item.id, agentId: randomUUID() })),
    );

    // The item was never linked, and no task was created for the session user.
    assert.equal(
      (await listChecklist(db, userId, dek)).find((i) => i.id === item.id)!.linkedTaskId,
      null,
      "the item is still unlinked after a refused hand-off",
    );
    assert.deepEqual(await listTasksForUser(db, userId, dek), [], "no task was created by a refused hand-off");
  } finally {
    await db.close();
  }
});

test("refreshMovingChecklist builds a checklist from a move; with no move it seeds nothing", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "refresh-move");
    const actions = makeActions(db, keyWrapper, { clock: fixedClock(NOW) });
    const session = sessionFor(userId);

    // A move on file plus a subscription record and a connected service (places that
    // hold the old address), all under the same dek the actions will unwrap.
    await setUpMove(db, userId, dek);
    await seedRecord(
      db,
      { userId, kind: "subscription", fields: { name: "Netflix" }, status: "active", source: { kind: "person" } },
      dek,
    );
    await createConnection(
      db,
      { userId, connectorId: "gmail", accountLabel: "me@example.com", credentials: { token: "t" } },
      dek,
      fixedClock(NOW),
    );

    const built = await actions.refreshMovingChecklist(session);
    assert.equal(okOf(built), true, "refreshMovingChecklist succeeds when a move is on file");

    const checklist = await listChecklist(db, userId, dek);
    assert.ok(checklist.length >= 2, `the move seeded checklist items; got ${checklist.length}`);
    assert.ok(
      checklist.some((i) => i.sourceKind === "subscription"),
      "a subscription on file was seeded as a checklist item",
    );
    assert.ok(
      checklist.some((i) => i.sourceKind === "connection"),
      "a connected service was seeded as a checklist item",
    );

    // A second person with no move set seeds nothing.
    const noMove = await makeUserWithDek(db, keyWrapper, "refresh-nomove");
    const built2 = await actions.refreshMovingChecklist(sessionFor(noMove.userId));
    assert.equal(okOf(built2), true, "refreshMovingChecklist succeeds even with no move");
    assert.deepEqual(
      await listChecklist(db, noMove.userId, noMove.dek),
      [],
      "with no move on file, nothing is seeded",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — attachReceiptFile duck-types the upload (never instanceof File) and stores ONLY
// DEK-encrypted ciphertext.
// =====================================================================================

test("attachReceiptFile accepts a duck-typed (non-File) upload and stores only DEK-encrypted ciphertext", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  const blob = createInMemoryBlobStore();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "attach-ok");
    const actions = makeActions(db, keyWrapper, { blob });
    const session = sessionFor(userId);

    // A receipt record to attach to (receipt_files.record_id is a FK to it).
    const receipt = await seedRecord(
      db,
      { userId, kind: "receipt_warranty", fields: { merchant: "JB Hi-Fi" }, status: "kept", source: { kind: "person" } },
      dek,
    );

    // A recognizable plaintext marker, so we can prove the blob never holds it in clear.
    const MARKER = "RECEIPT-PLAINTEXT-MARKER-5f3a";
    const plaintext = new TextEncoder().encode(`${MARKER}-pretend-pdf-bytes`);

    const result = await actions.attachReceiptFile(
      session,
      as<"attachReceiptFile">({ recordId: receipt.id, file: fakeUpload("receipt.pdf", plaintext) }),
    );
    assert.equal(okOf(result), true, "a duck-typed (non-File) upload is accepted (never instanceof File)");

    // A receipt_files row exists for this record, member-scoped.
    const row = await db.query(
      "SELECT id, blob_key FROM receipt_files WHERE user_id = $1 AND record_id = $2",
      [userId, receipt.id],
    );
    assert.equal(row.rows.length, 1, "exactly one receipt-file row was stored");
    const { id: fileId, blob_key: blobKey } = row.rows[0] as { id: string; blob_key: string };

    // The blob holds ONLY ciphertext — the plaintext marker never appears in it.
    const storedBlob = await blob.get(blobKey);
    assert.ok(storedBlob != null, "the ciphertext is in the blob store");
    assert.equal(
      Buffer.from(storedBlob!).includes(Buffer.from(MARKER)),
      false,
      "the blob stores encrypted ciphertext, not the plaintext bytes",
    );

    // …and the owner's DEK decrypts it back to exactly the plaintext (through the store).
    const fetched = await getReceiptFile(db, blob, { userId, id: fileId }, dek);
    assert.ok(fetched != null, "the owner can read their file back");
    assert.deepEqual(
      Array.from(fetched!.bytes),
      Array.from(plaintext),
      "the decrypted bytes equal the uploaded plaintext",
    );

    // The loader now flags the receipt as having an attached file.
    const data = await actions.load(session);
    const loadedReceipt = data.receipts.find((r: { id: string }) => r.id === receipt.id);
    assert.ok(loadedReceipt != null, "the receipt appears on the loaded screen");
    assert.equal(loadedReceipt!.hasAttachedFile, true, "the loader flags the receipt as having an attached file");
  } finally {
    await db.close();
  }
});

test("attachReceiptFile rejects a non-file / malformed upload with a 4xx and stores nothing", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "attach-bad");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);
    const receipt = await seedRecord(
      db,
      { userId, kind: "receipt_warranty", fields: { merchant: "Officeworks" }, status: "kept", source: { kind: "person" } },
      dek,
    );

    // A string, an object missing `size`, and an object missing `name` — none pass the
    // duck-type (`typeof name === "string" && typeof size === "number"`).
    await assertRejects4xx("attachReceiptFile(file is a string)", () =>
      actions.attachReceiptFile(session, as<"attachReceiptFile">({ recordId: receipt.id, file: "not a file" })),
    );
    await assertRejects4xx("attachReceiptFile(file missing size)", () =>
      actions.attachReceiptFile(session, as<"attachReceiptFile">({ recordId: receipt.id, file: { name: "x.pdf" } })),
    );
    await assertRejects4xx("attachReceiptFile(file missing name)", () =>
      actions.attachReceiptFile(session, as<"attachReceiptFile">({ recordId: receipt.id, file: { size: 10 } })),
    );

    const row = await db.query("SELECT id FROM receipt_files WHERE user_id = $1", [userId]);
    assert.equal(row.rows.length, 0, "no receipt-file row was stored for a malformed upload");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a malformed id is a 4xx (not a raw cast); a signed-in user cannot read or change
// another user's records/tasks/checklist by id.
// =====================================================================================

test("a malformed record / task / checklist id is rejected with a 4xx before any query (OBS-049)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "bad-id");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // Not a well-formed uuid — including a bare integer, a negative, a decimal, the empty
    // string, whitespace and a SQL-shaped id. Each is rejected at the boundary BEFORE it
    // can reach `WHERE id = $1` as a cast (so it never surfaces as a 500, and a SQL-shaped
    // id never reaches a query). "A bare integer is rejected" subsumes the criterion's
    // "not a positive integer".
    const badIds = ["5", "-1", "1.5", "", "   ", "not-a-uuid", "x'; DROP TABLE tasks; --"];
    for (const badId of badIds) {
      await assertRejects4xx(`updateRecord(id=${JSON.stringify(badId)})`, () =>
        actions.updateRecord(session, as<"updateRecord">({ id: badId, fields: { a: "b" }, status: "active" })),
      );
      await assertRejects4xx(`setRecordReminders(id=${JSON.stringify(badId)})`, () =>
        actions.setRecordReminders(session, as<"setRecordReminders">({ id: badId, reminderOffsets: [1] })),
      );
      await assertRejects4xx(`toggleChecklistItem(id=${JSON.stringify(badId)})`, () =>
        actions.toggleChecklistItem(session, as<"toggleChecklistItem">({ id: badId })),
      );
      await assertRejects4xx(`handChecklistItemToAgent(id=${JSON.stringify(badId)})`, () =>
        actions.handChecklistItemToAgent(session, as<"handChecklistItemToAgent">({ id: badId })),
      );
      await assertRejects4xx(`updateTask(id=${JSON.stringify(badId)})`, () =>
        actions.updateTask(session, as<"updateTask">({ id: badId, title: "x", assignee: "any", status: "open" })),
      );
      await assertRejects4xx(`completeTask(id=${JSON.stringify(badId)})`, () =>
        actions.completeTask(session, as<"completeTask">({ id: badId })),
      );
      await assertRejects4xx(`assignTask(id=${JSON.stringify(badId)})`, () =>
        actions.assignTask(session, as<"assignTask">({ id: badId, assignee: "any" })),
      );
      await assertRejects4xx(`addTaskNote(id=${JSON.stringify(badId)})`, () =>
        actions.addTaskNote(session, as<"addTaskNote">({ id: badId, text: "x" })),
      );
      await assertRejects4xx(`attachReceiptFile(recordId=${JSON.stringify(badId)})`, () =>
        actions.attachReceiptFile(session, as<"attachReceiptFile">({ recordId: badId, file: fakeUpload("r.pdf", new Uint8Array([1, 2, 3])) })),
      );
    }

    // The tables are intact — no SQL-shaped id was ever executed.
    assert.equal(await tableExists(db, "tasks"), true, "the tasks table survives a SQL-shaped id");
    assert.equal(await tableExists(db, "life_admin_records"), true, "the records table survives");
    assert.equal(await tableExists(db, "moving_checklist"), true, "the checklist table survives");
  } finally {
    await db.close();
  }
});

test("the loader reads ONLY the session user's data — another person's records / tasks / checklist never appear", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "read-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "read-other");
    const actions = makeActions(db, keyWrapper);

    await seedRecord(
      db,
      { userId: alice.userId, kind: "subscription", fields: { service: "Alice only subscription" }, status: "active", source: { kind: "person" } },
      alice.dek,
    );
    await seedTask(db, { userId: alice.userId, title: "Alice only task", assignee: "any", createdBy: { kind: "person" } }, alice.dek);
    await seedChecklistItem(db, { userId: alice.userId, label: "Alice only checklist" }, alice.dek);

    await seedRecord(
      db,
      { userId: bob.userId, kind: "subscription", fields: { service: "Bob own subscription" }, status: "active", source: { kind: "person" } },
      bob.dek,
    );

    const bobsScreen = await actions.load(sessionFor(bob.userId));

    const whole = JSON.stringify(bobsScreen);
    assert.ok(whole.includes("Bob own subscription"), "Bob sees his own record");
    assert.ok(!whole.includes("Alice only subscription"), "Alice's record never appears on Bob's screen");
    assert.ok(!whole.includes("Alice only task"), "Alice's task never appears on Bob's screen");
    assert.ok(!whole.includes("Alice only checklist"), "Alice's checklist never appears on Bob's screen");
  } finally {
    await db.close();
  }
});

test("a signed-in user cannot change another person's record, task or checklist by id — they are untouched and nothing is created", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "change-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "change-attacker");
    const actions = makeActions(db, keyWrapper);
    const bobSession = sessionFor(bob.userId);

    const alicesRecord = await seedRecord(
      db,
      { userId: alice.userId, kind: "subscription", fields: { service: "Alice secret" }, status: "active", source: { kind: "person" } },
      alice.dek,
    );
    const alicesTask = await seedTask(
      db,
      { userId: alice.userId, title: "Alice secret task", assignee: "any", createdBy: { kind: "person" } },
      alice.dek,
    );
    const alicesItem = await seedChecklistItem(db, { userId: alice.userId, label: "Alice secret item" }, alice.dek);

    // Bob, holding Alice's real ids, tries every mutation. Each is refused (member-scoped
    // by Bob's session id) — never an uncontrolled 500.
    await assertRejected("updateRecord(bob → alice's record)", () =>
      actions.updateRecord(bobSession, as<"updateRecord">({ id: alicesRecord.id, fields: { service: "hijacked" }, status: "active" })),
    );
    await assertRejected("setRecordReminders(bob → alice's record)", () =>
      actions.setRecordReminders(bobSession, as<"setRecordReminders">({ id: alicesRecord.id, reminderOffsets: [99] })),
    );
    await assertRejected("attachReceiptFile(bob → alice's record)", () =>
      actions.attachReceiptFile(bobSession, as<"attachReceiptFile">({ recordId: alicesRecord.id, file: fakeUpload("x.pdf", new Uint8Array([1, 2, 3])) })),
    );
    await assertRejected("updateTask(bob → alice's task)", () =>
      actions.updateTask(bobSession, as<"updateTask">({ id: alicesTask.id, title: "hijacked", assignee: "any", status: "done" })),
    );
    await assertRejected("assignTask(bob → alice's task)", () =>
      actions.assignTask(bobSession, as<"assignTask">({ id: alicesTask.id, assignee: "any" })),
    );
    await assertRejected("addTaskNote(bob → alice's task)", () =>
      actions.addTaskNote(bobSession, as<"addTaskNote">({ id: alicesTask.id, text: "hijacked" })),
    );
    await assertRejected("completeTask(bob → alice's task)", () =>
      actions.completeTask(bobSession, as<"completeTask">({ id: alicesTask.id })),
    );
    await assertRejected("toggleChecklistItem(bob → alice's item)", () =>
      actions.toggleChecklistItem(bobSession, as<"toggleChecklistItem">({ id: alicesItem.id })),
    );
    await assertRejected("handChecklistItemToAgent(bob → alice's item)", () =>
      actions.handChecklistItemToAgent(bobSession, as<"handChecklistItemToAgent">({ id: alicesItem.id })),
    );

    // Alice's data is unchanged.
    const alicesRecordAfter = (await listRecordsForUser(db, alice.userId, alice.dek)).find((r) => r.id === alicesRecord.id);
    assert.equal((alicesRecordAfter!.fields as { service?: string }).service, "Alice secret", "Alice's record is unchanged");
    const alicesTaskAfter = (await listTasksForUser(db, alice.userId, alice.dek)).find((t) => t.id === alicesTask.id);
    assert.equal(alicesTaskAfter!.title, "Alice secret task", "Alice's task title is unchanged");
    assert.equal(alicesTaskAfter!.status, "open", "Alice's task was not completed by Bob");
    const alicesItemAfter = (await listChecklist(db, alice.userId, alice.dek)).find((i) => i.id === alicesItem.id);
    assert.equal(alicesItemAfter!.done, false, "Alice's checklist item was not ticked off by Bob");
    assert.equal(alicesItemAfter!.linkedTaskId, null, "Alice's checklist item was not handed off by Bob");

    // Bob gained nothing from the borrowed ids: no receipt file, no task.
    const bobFiles = await db.query("SELECT id FROM receipt_files WHERE user_id = $1", [bob.userId]);
    assert.equal(bobFiles.rows.length, 0, "Bob's refused attach created no receipt file");
    assert.deepEqual(await listTasksForUser(db, bob.userId, bob.dek), [], "Bob's refused hand-off created no task for him");
  } finally {
    await db.close();
  }
});

test("saveRecord / createTask take the owner from the session — a userId smuggled in the input is ignored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const session = await makeUserWithDek(db, keyWrapper, "scope-session");
    const victim = await makeUserWithDek(db, keyWrapper, "scope-victim");
    const actions = makeActions(db, keyWrapper);

    const savedRecord = await actions.saveRecord(
      sessionFor(session.userId),
      as<"saveRecord">({ kind: "subscription", fields: { service: "Smuggled record" }, status: "active", userId: victim.userId }),
    );
    assert.equal(okOf(savedRecord), true, "the record save succeeds under the session user");
    const savedTask = await actions.createTask(
      sessionFor(session.userId),
      as<"createTask">({ title: "Smuggled task", userId: victim.userId }),
    );
    assert.equal(okOf(savedTask), true, "the task create succeeds under the session user");

    // Everything landed under the SESSION user, never the smuggled victim id.
    assert.ok(
      (await listRecordsForUser(db, session.userId, session.dek)).some((r) => (r.fields as { service?: string }).service === "Smuggled record"),
      "the record is stored under the session user",
    );
    assert.deepEqual(await listRecordsForUser(db, victim.userId, victim.dek), [], "the victim gained no record");
    assert.ok(
      (await listTasksForUser(db, session.userId, session.dek)).some((t) => t.title === "Smuggled task"),
      "the task is stored under the session user",
    );
    assert.deepEqual(await listTasksForUser(db, victim.userId, victim.dek), [], "the victim gained no task");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
// probe in an input field is bound as data (parameter binding).
// [obligation:validate-and-parameterize-input]
// =====================================================================================

test("malformed / oversized input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "malformed");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);
    const HUGE = "x".repeat(200_000);

    // saveRecord: an unknown kind, a missing kind, and a grossly oversized field value.
    await assertRejects4xx("saveRecord(unknown kind)", () =>
      actions.saveRecord(session, as<"saveRecord">({ kind: "nonsense", fields: { a: "b" }, status: "active" })),
    );
    await assertRejects4xx("saveRecord(missing kind)", () =>
      actions.saveRecord(session, as<"saveRecord">({ fields: { a: "b" }, status: "active" })),
    );
    await assertRejects4xx("saveRecord(oversized field value)", () =>
      actions.saveRecord(session, as<"saveRecord">({ kind: "subscription", fields: { note: HUGE }, status: "active" })),
    );
    // createTask: a missing title, a non-string title, and a grossly oversized title.
    await assertRejects4xx("createTask(missing title)", () =>
      actions.createTask(session, as<"createTask">({})),
    );
    await assertRejects4xx("createTask(title not a string)", () =>
      actions.createTask(session, as<"createTask">({ title: 42 })),
    );
    await assertRejects4xx("createTask(oversized title)", () =>
      actions.createTask(session, as<"createTask">({ title: HUGE })),
    );

    // Nothing was persisted by any rejected call.
    assert.deepEqual(await listRecordsForUser(db, userId, dek), [], "no malformed record was stored");
    assert.deepEqual(await listTasksForUser(db, userId, dek), [], "no malformed task was stored");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a record field / task title is bound as data: the tables survive and the values round-trip", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "sqli");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // If concatenated into the statement text these would corrupt the query (or run the
    // trailing statement); bound as parameters they are inert — and additionally
    // DEK-encrypted before they are bound.
    const recordProbe = "Robert'); DROP TABLE life_admin_records; --";
    const taskProbe = "Bobby'); DROP TABLE tasks; --";

    const r = await actions.saveRecord(
      session,
      as<"saveRecord">({ kind: "subscription", fields: { service: recordProbe }, status: "active" }),
    );
    assert.equal(okOf(r), true, "a record field shaped like SQL is accepted and stored as data");
    const t = await actions.createTask(session, as<"createTask">({ title: taskProbe }));
    assert.equal(okOf(t), true, "a task title shaped like SQL is accepted and stored as data");

    assert.equal(await tableExists(db, "life_admin_records"), true, "the records table survives the probe");
    assert.equal(await tableExists(db, "tasks"), true, "the tasks table survives the probe");

    assert.ok(
      (await listRecordsForUser(db, userId, dek)).some((rec) => (rec.fields as { service?: string }).service === recordProbe),
      "the SQL-shaped record field round-trips verbatim as data (decrypted)",
    );
    assert.ok(
      (await listTasksForUser(db, userId, dek)).some((task) => task.title === taskProbe),
      "the SQL-shaped task title round-trips verbatim as data (decrypted)",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret value lands in a loaded/saved result; config is read from env.
// [obligation:secrets-from-env] — the module reads no process.env and holds no secret, so
// no ambient env value can leak into what it stores or the screen it loads.
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
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const r = await actions.saveRecord(
      session,
      as<"saveRecord">({ kind: "subscription", fields: { service: "Env record" }, status: "active" }),
    );
    assert.equal(okOf(r), true, "the record save works from the injected seams with a decoy env present");
    const t = await actions.createTask(session, as<"createTask">({ title: "Env task" }));
    assert.equal(okOf(t), true, "the task create works from the injected seams");

    // The decoy appears in neither the loaded screen…
    const data = await actions.load(session);
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env value is folded into the loaded screen");

    // …nor the stored rows.
    assert.ok(
      !JSON.stringify(await listRecordsForUser(db, userId, dek)).includes(DECOY),
      "no ambient env value is folded into the stored record",
    );
    assert.ok(
      !JSON.stringify(await listTasksForUser(db, userId, dek)).includes(DECOY),
      "no ambient env value is folded into the stored task",
    );
  } finally {
    await db.close();
    if (prevDecoy === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prevDecoy;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
});


test("record dates and reminder offsets reject impossible scheduling before writes, preserve omitted dates, and allow clearing", async () => {
  const db = await freshDb();
  const wrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, wrapper, "schedule-boundary");
    const actions = makeActions(db, wrapper), session = sessionFor(userId);
    for (const dueDate of ["2027-02-30", "0000-01-01", "tomorrow", "2027-01-01T00:00:00Z"]) {
      await assertRejects4xx("invalid calendar date", () => actions.saveRecord(session, { kind: "subscription", fields: {}, dueDate }));
    }
    for (const reminderOffsets of [[2147483647], [-1], [1.5]]) {
      await assertRejects4xx("unsafe reminder offset", () => actions.saveRecord(session, { kind: "subscription", fields: {}, reminderOffsets }));
    }
    assert.equal((await listRecordsForUser(db, userId, dek)).length, 0);
    await actions.saveRecord(session, { kind: "subscription", fields: { name: "Leap renewal" }, dueDate: "2028-02-29" });
    const record = (await listRecordsForUser(db, userId, dek))[0];
    await actions.updateRecord(session, { id: record.id, fields: { name: "Edited" } });
    assert.equal((await listRecordsForUser(db, userId, dek))[0].dueDate, "2028-02-29");
    await actions.updateRecord(session, { id: record.id, fields: { name: "Cleared" }, dueDate: null });
    assert.equal((await listRecordsForUser(db, userId, dek))[0].dueDate, null);
  } finally { await db.close(); }
});
