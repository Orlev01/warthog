// Review fix G2 — the Data & privacy export DOWNLOAD
// (`src/app/(portal)/(protected)/settings/data/export/handler.ts`, served by the thin
// sibling `route.ts` at POST /settings/data/export).
//
// Before this fix the Export control built the whole archive in a server action and then
// threw it away, telling the person "Your data export has been prepared" while no file
// ever reached them (brief flow 11: export and see the download). The handler now
// returns the export document itself as a JSON attachment — after the same fresh step-up
// the export action enforces — and never caches it.
//
// Real seams over an in-memory PGlite (src/test/db): a real user whose wrapped DEK
// unwraps under a real local KeyWrapper, a real session row and the real recordStepUp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createExportHandler } from "./handler";

import { createUser } from "@/server/db/users";
import { createMemory } from "@/server/db/memories";
import { createSession, recordStepUp, COOKIE_NAME } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { exportDocumentSchema } from "@/server/export/schema";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const ORIGIN = "https://warthog.test";
const T0 = new Date("2026-06-01T00:00:00.000Z");
const clock = fixedClock(T0);
const staleClock = fixedClock(new Date(T0.getTime() + 6 * 60 * 1000));

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string, memory: string) {
  const dek = randomBytes(32);
  const user = await createUser(db, {
    email: `${who}-${randomBytes(4).toString("hex")}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  await createMemory(db, { userId: user.id, content: memory, sourceAgentId: null, scope: "shared" }, dek, clock);
  return user.id;
}

async function cookieFor(db: Db, userId: string, opts: { steppedUp: boolean }): Promise<string> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  if (opts.steppedUp) await recordStepUp(db, created.session.id, { clock });
  return `${COOKIE_NAME}=${created.token}`;
}

function post(cookie: string | null, origin: string | null = ORIGIN): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  return new Request(`${ORIGIN}/settings/data/export`, { method: "POST", headers });
}

test("a freshly stepped-up person gets their export as a no-store JSON attachment holding only their own data", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const ada = await makePerson(db, keyWrapper, "ada", "Ada likes quokkas");
    await makePerson(db, keyWrapper, "bob", "Bob's private note");
    const handle = createExportHandler({ db, clock, keyWrapper, publicOrigin: ORIGIN });

    const response = await handle(post(await cookieFor(db, ada, { steppedUp: true })));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="warthog-export-2026-06-01\.json"$/,
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = await response.text();
    const parsed = exportDocumentSchema.safeParse(JSON.parse(body));
    assert.ok(parsed.success, "the body is a valid Warthog export document");
    assert.ok(body.includes("Ada likes quokkas"), "the export carries the person's own content");
    assert.ok(!body.includes("Bob's private note"), "another person's content is never exported");
  } finally {
    await db.close();
  }
});

test("without a fresh step-up nothing is exported: the person is sent back to confirm it's them", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const ada = await makePerson(db, keyWrapper, "ada-stale", "Ada secret");
    const neverStepped = createExportHandler({ db, clock, keyWrapper, publicOrigin: ORIGIN });
    const stale = createExportHandler({ db, clock: staleClock, keyWrapper, publicOrigin: ORIGIN });

    for (const [label, handle, cookie] of [
      ["never stepped up", neverStepped, await cookieFor(db, ada, { steppedUp: false })],
      ["stale step-up", stale, await cookieFor(db, ada, { steppedUp: true })],
    ] as const) {
      const response = await handle(post(cookie));
      assert.equal(response.status, 303, label);
      assert.equal(response.headers.get("location"), "/settings/data?notice=step_up_required", label);
      assert.ok(!(await response.text()).includes("Ada secret"), `${label}: no data in the body`);
    }
  } finally {
    await db.close();
  }
});

test("a cross-site or Origin-less POST is refused and a signed-out request is sent to sign in", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const ada = await makePerson(db, keyWrapper, "ada-csrf", "Ada secret");
    const handle = createExportHandler({ db, clock, keyWrapper, publicOrigin: ORIGIN });
    const cookie = await cookieFor(db, ada, { steppedUp: true });

    const foreign = await handle(post(cookie, "https://evil.example"));
    assert.equal(foreign.status, 403);
    assert.ok(!(await foreign.text()).includes("Ada secret"));
    assert.equal((await handle(post(cookie, null))).status, 403);

    const signedOut = await handle(post(null));
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.get("location"), "/signin");
    const bogus = await handle(post(`${COOKIE_NAME}=not-a-real-token`));
    assert.equal(bogus.headers.get("location"), "/signin");
  } finally {
    await db.close();
  }
});
