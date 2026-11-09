// E16-S11 — Data & privacy page loader + the mounted controls
// (`src/app/(portal)/(protected)/settings/data/`).
//
// RED-first: the data-and-privacy LOADER seam does NOT exist yet (the settings/data dir
// holds only a placeholder `page.tsx`), so importing `createDataActions` from `./actions`
// throws and every test here fails until the builder adds it. That absence IS the point of
// test-first — do NOT implement anything to make these pass; the builder writes the loader
// afterwards as the minimum code that turns these green.
//
// Why these tests live in a SIBLING of `page.tsx`: a Next `page.tsx` entry file may export
// ONLY its framework fields (its default page component), so the injectable, unit-testable
// loader logic can't live there without breaking `next build`. The thin `page.tsx` reads
// the signed-in session from the host-locked session cookie + the process-wide database,
// reads this person's imported-history archive (and their vault ciphertext) through this
// seam's `load`, and mounts the already-render-tested <DataView> (E16-S10) WIRED to the
// three server actions (export / import / delete). The testable loader lives in the plain
// sibling module `./actions` (`createDataActions(deps).load`), so these tests drive it
// directly against an isolated in-memory PGlite with the REAL migrations (`@/test/db`) and
// the REAL imported-history store — no network, no Azure — and none asserts on the source
// text of any module, so a behaviour-preserving refactor stays green.
//
// WHAT THE LOADER DOES (the acceptance criterion): it reads the session person's
// imported-history archive (member-scoped by `session.userId`, never a client value) and
// returns the data that mounts <DataView>. A person never sees another person's imported
// history.
//
// WHAT THE PAGE MOUNTS (the acceptance criterion "export, import and delete controls are
// all mounted on the rendered page"): the loaded data + the three wired actions render a
// <DataView> that carries an Export control, an Import control, and a Delete-account
// control. The view is rendered with `react-dom/server` (no DOM/jsdom — React component /
// E2E testing is a per-job ADR), exactly as the sibling notifications/inbox page tests do.
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createDataActions } from "./actions";

import { DataView, type DataViewImportedEntry } from "@/components/settings/data-view";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { createImportedEntry } from "@/server/db/imported-history";
import type { DeletionExecutor } from "@/server/account/delete";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createOutbox, type Outbox } from "@/server/notify/outbox";
import type { Senders } from "@/server/notify/senders";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32;
const KEK_BYTES = 32;

const NOW = new Date("2026-06-01T12:00:00.000Z");
const clock: Clock = fixedClock(NOW);

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// A no-op revoker — the loader never deletes; it is only in the deps bundle because the
// factory also wires the delete action. The senders are a throwaway outbox (unused by load).
const noopRevoker: DeletionExecutor = {
  async revokeAgentsAndConnections(): Promise<void> {},
};

// Build the data actions over the real seams exactly as the page builds them, so `load`
// runs against the real imported-history store.
function makeActions(db: Db, keyWrapper: KeyWrapper) {
  const outbox: Outbox = createOutbox();
  const senders: Senders = { push: outbox, email: outbox, sms: outbox };
  return createDataActions({ db, clock, keyWrapper, revoker: noopRevoker, senders });
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

// Seed one archived imported-history entry for `userId` (content DEK-encrypted at rest),
// returning its id — the stable handle the loader surfaces to the view.
async function seedArchived(
  db: Db,
  userId: string,
  dek: Uint8Array,
  token: string,
): Promise<string> {
  const entry = await createImportedEntry(
    db,
    {
      userId,
      content: { note: `archived activity ${token}` },
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "payment",
      source: "agent_reported",
    },
    dek,
  );
  return entry.id;
}

// --- markup helpers (no DOM), mirrored from the sibling component/page tests -----------

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Render the DataView the way the page mounts it: the loaded imported history plus the
// three wired server actions.
function renderPage(importedHistory: ReadonlyArray<DataViewImportedEntry>): string {
  const noop = async (): Promise<void> => {};
  return renderToStaticMarkup(
    <DataView
      importedHistory={importedHistory}
      deleteAccountAction={noop}
    />,
  );
}

// =====================================================================================
// AC — the loader returns the session person's imported-history archive, and that data
// mounts <DataView>. The archive rows are surfaced by the stable ids the view keys on.
// =====================================================================================

test("the loader returns the session person's imported history, which mounts in the view", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const id1 = await seedArchived(db, alice.userId, alice.dek, "one");
    const id2 = await seedArchived(db, alice.userId, alice.dek, "two");

    const data = await makeActions(db, keyWrapper).load(await sessionFor(db, alice.userId));

    // Both archived entries, by the ids the store generated (the view's list keys).
    assert.deepEqual(
      new Set(data.importedHistory.map((e) => e.id)),
      new Set([id1, id2]),
      "the loader returns the person's imported-history entries",
    );

    // Each entry is display-ready (the shape <DataView> renders).
    for (const entry of data.importedHistory) {
      assert.equal(typeof entry.kind, "string", "each entry carries a display-ready kind label");
      assert.equal(typeof entry.at, "string", "each entry carries a pre-formatted time label");
      assert.equal(typeof entry.summary, "string", "each entry carries a one-line summary");
    }

    // That data MOUNTS the view: the archive is shown (not the empty state).
    const markup = renderPage(data.importedHistory);
    assert.ok(
      !visibleText(markup).includes("Nothing has been imported yet"),
      "with imported history, the archive renders rather than the empty state",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC — the export, import and delete controls are ALL mounted on the rendered page (fed
// by the loader's data and wired to the three actions).
// =====================================================================================

test("the rendered page mounts the export, import and delete controls", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const data = await makeActions(db, keyWrapper).load(await sessionFor(db, alice.userId));

    const markup = renderPage(data.importedHistory);
    const text = visibleText(markup);

    // Export — a control to download everything.
    assert.match(text, /export my data/i, "the Export control is mounted");
    // Import — a file picker plus its submit control.
    assert.match(text, /import this file/i, "the Import control is mounted");
    assert.ok(/type="file"/.test(markup), "the Import control exposes a device-local file input");
    // Delete — a destructive control gated by the typed confirmation.
    assert.match(text, /delete my account/i, "the Delete-account control is mounted");
    assert.ok(/name="confirmation"/.test(markup), "the Delete control exposes its confirmation field");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC — a fresh account (no imported history) loads an EMPTY archive, and the view shows
// its empty state while still mounting all three controls.
// =====================================================================================

test("a fresh account loads an empty imported history and shows the empty state with the controls present", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");

    const data = await makeActions(db, keyWrapper).load(await sessionFor(db, alice.userId));
    assert.equal(data.importedHistory.length, 0, "a fresh account has an empty imported history");

    const markup = renderPage(data.importedHistory);
    const text = visibleText(markup);
    assert.ok(text.includes("Nothing has been imported yet"), "the empty state is shown when nothing is imported");
    // The controls are mounted even with an empty archive — no dead/absent controls.
    assert.match(text, /export my data/i, "the Export control is still mounted on an empty archive");
    assert.match(text, /import this file/i, "the Import control is still mounted on an empty archive");
    assert.match(text, /delete my account/i, "the Delete control is still mounted on an empty archive");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Member scope / ownership — a person never sees ANOTHER person's imported history; the
// loader reads only the session user's own rows (never a client value).
// =====================================================================================

test("a person never sees another person's imported history", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");

    const aliceId = await seedArchived(db, alice.userId, alice.dek, "alice-entry");
    const bobId = await seedArchived(db, bob.userId, bob.dek, "bob-entry");

    const aliceData = await makeActions(db, keyWrapper).load(await sessionFor(db, alice.userId));

    // Only Alice's archive entry; never Bob's.
    assert.deepEqual(
      aliceData.importedHistory.map((e) => e.id),
      [aliceId],
      "the loader returns only the session person's imported history",
    );
    assert.ok(
      !aliceData.importedHistory.some((e) => e.id === bobId),
      "another person's imported-history entry never appears in this person's archive",
    );
    assert.ok(
      !JSON.stringify(aliceData.importedHistory).includes("bob-entry"),
      "no content from another person's archive leaks into this person's data",
    );
  } finally {
    await db.close();
  }
});
