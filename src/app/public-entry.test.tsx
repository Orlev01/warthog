import { withPageRequest } from "../test/page-request";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "./page";
import SignInPage from "./(auth)/signin/page";
import SignUpPage from "./(auth)/signup/page";
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

function signup(cookie?: string, next?: unknown) {
  return withPageRequest("/signup", cookie, () =>
    SignUpPage({
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

// The tests up to the website section are about an app whose root shows the front door, so
// they pin a public base URL with no separate website host.
const NO_WEBSITE = "http://localhost:3000";

test("a missing session serves public pages without opening a database", async () => {
  shared[key] = async () => {
    throw new Error("anonymous entry must not query a database");
  };
  try {
    assert.match(renderToStaticMarkup(await signin()), /Welcome back/);
    await withPublicBaseUrl(NO_WEBSITE, async () => {
      assert.match(
        renderToStaticMarkup(await withPageRequest("/", undefined, () => Home())),
        /Sign up/,
      );
    });
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
    await withPublicBaseUrl(NO_WEBSITE, async () => {
      assert.match(
        renderToStaticMarkup(
          await withPageRequest("/", `__Host-wh_session=${value}`, () => Home()),
        ),
        /Sign up/,
      );
    });
  }
});

// --- The website's own host (docs/adr/website-root-domain.md) ------------------------------

async function withPublicBaseUrl<T>(value: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = saved;
  }
}

function hrefsOf(markup: string): string[] {
  return [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)].map((m) => m[1]!);
}

test("the website host always shows the front door, signed in or not, without opening a database", async () => {
  await withPublicBaseUrl("https://app.warthog.example", async () => {
    shared[key] = async () => {
      throw new Error("the website host must not query a database");
    };
    try {
      for (const cookie of [undefined, `__Host-wh_session=${token}`]) {
        const markup = renderToStaticMarkup(
          await withPageRequest("/", cookie, () => Home(), { host: "warthog.example" }),
        );
        assert.match(markup, /Your rules\./);
        const links = hrefsOf(markup);
        assert.ok(links.includes("https://app.warthog.example/signin"), "Sign in goes to the app");
        assert.ok(links.includes("https://app.warthog.example/signup"), "Sign up goes to the app");
        assert.ok(links.includes("https://warthog.example/"), "the brand stays on the website");
        assert.ok(!links.some((href) => href === "/signin" || href === "/signup"), "no account link is relative to the website");
      }
    } finally {
      shared[key] = async () => db;
    }
  });
});

test("with a website host, the app's root sends signed-out visitors to sign-in and members home", async () => {
  await withPublicBaseUrl("https://app.warthog.example", async () => {
    const app = { host: "app.warthog.example" };
    await expectRedirect(() => withPageRequest("/", undefined, () => Home(), app), "/signin");
    await expectRedirect(() => withPageRequest("/", "__Host-wh_session=malformed", () => Home(), app), "/signin");
    await expectRedirect(() => withPageRequest("/", `__Host-wh_session=${token}`, () => Home(), app), "/home");
  });
});

test("without a website host the app's root keeps the front door with relative account links", async () => {
  await withPublicBaseUrl("http://localhost:3000", async () => {
    const markup = renderToStaticMarkup(
      await withPageRequest("/", undefined, () => Home(), { host: "localhost:3000" }),
    );
    assert.ok(hrefsOf(markup).includes("/signin"));
    assert.ok(hrefsOf(markup).includes("/signup"));
  });
});

// The website's Sign up buttons can't know the app's host-only session, so a member who
// follows one is sent on like sign-in does; everyone else still sees the form.
test("a signed-in member who opens sign-up goes Home or to a safe return path; visitors see the form", async () => {
  const cookie = `__Host-wh_session=${token}`;
  await expectRedirect(() => signup(cookie), "/home");
  const next = "/oauth/authorize?state=opaque&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback";
  await expectRedirect(() => signup(cookie, next), next);
  await expectRedirect(() => signup(cookie, "//evil.example"), "/home");
  for (const visitor of [undefined, "__Host-wh_session=malformed"]) {
    assert.match(renderToStaticMarkup(await signup(visitor)), /Create your account/);
  }
});
