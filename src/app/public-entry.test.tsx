import { withPageRequest } from "../test/page-request";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "./page";
import SignInPage from "./(auth)/signin/page";
import { freshDb } from "../test/db";
import { createUser } from "../server/db/users";
import { createSession, deleteSession } from "../server/auth/session";
import { systemClock, fixedClock } from "../server/seams/clock";
import { systemRandom } from "../server/seams/random";
import type { Db } from "../server/db";

const key = Symbol.for("warthog.serverDb");
const shared = globalThis as typeof globalThis & { [key]?: () => Promise<Db> };
let db: Db;
let userId: string;
let token: string;
const originalDb = shared[key];

before(async () => {
  db = await freshDb();
  const user = await createUser(db, {
    email: "public-entry@example.test",
    wrappedDek: "fixture-wrapped-dek",
  });
  userId = user.id;
  token = (
    await createSession(db, user.id, {
      clock: systemClock,
      random: systemRandom,
    })
  ).token;
  shared[key] = async () => db;
});
after(async () => {
  if (originalDb) shared[key] = originalDb;
  else delete shared[key];
  await db?.close();
});

function signin(cookie?: string, next?: unknown) {
  return withPageRequest("/signin", cookie, () =>
    SignInPage({
      searchParams: Promise.resolve({ next } as Record<
        string,
        string | string[] | undefined
      >),
    }),
  );
}

async function expectRedirect(action: () => unknown, destination: string) {
  await assert.rejects(
    async () => action(),
    (error: unknown) => {
      assert.equal(
        (error as { digest?: string }).digest,
        `NEXT_REDIRECT;replace;${destination};307;`,
      );
      return true;
    },
  );
}

test("an existing valid session skips sign-in and the public landing", async () => {
  const cookie = `__Host-wh_session=${token}`;
  await expectRedirect(() => signin(cookie), "/home");
  await expectRedirect(
    () => withPageRequest("/", cookie, () => Home()),
    "/home",
  );
});

test("signed-in visitors retain a safe return path including OAuth callback data", async () => {
  const next =
    "/oauth/authorize?state=opaque&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback";
  await expectRedirect(() => signin(`__Host-wh_session=${token}`, next), next);
});

test("external, ambiguous and self-referential return paths go to Home", async () => {
  for (const next of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/signin?next=/signin",
    ["/inbox", "/vault"],
  ]) {
    await expectRedirect(
      () => signin(`__Host-wh_session=${token}`, next),
      "/home",
    );
  }
});

test("a missing session serves public pages without opening a database", async () => {
  shared[key] = async () => {
    throw new Error("anonymous entry must not query a database");
  };
  try {
    assert.match(renderToStaticMarkup(await signin()), /Welcome back/);
    assert.match(
      renderToStaticMarkup(await withPageRequest("/", undefined, () => Home())),
      /Sign up/,
    );
  } finally {
    shared[key] = async () => db;
  }
});

test("a cookie is not proof: forged, expired and revoked sessions still see sign-in", async () => {
  const old = await createSession(db, userId, {
    clock: fixedClock(new Date(Date.now() - 15 * 86400000)),
    random: systemRandom,
  });
  const revoked = await createSession(db, userId, {
    clock: systemClock,
    random: systemRandom,
  });
  await deleteSession(db, revoked.token);
  for (const value of ["malformed", "f".repeat(64), old.token, revoked.token]) {
    assert.match(
      renderToStaticMarkup(await signin(`__Host-wh_session=${value}`)),
      /Welcome back/,
    );
    assert.match(
      renderToStaticMarkup(
        await withPageRequest("/", `__Host-wh_session=${value}`, () => Home()),
      ),
      /Sign up/,
    );
  }
});
