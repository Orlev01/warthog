// E18-S13 — Early home page mount (src/app/(portal)/(protected)/home/).
//
// RED-first: the home loader seam does NOT exist yet, so importing `./actions`
// throws and every test here fails until the builder adds it. That absence IS the
// point of test-first — do NOT implement anything to make these pass.
//
// WHY this exists (task E18-S13): sign-up and sign-in land on `/home`, so the route
// must mount the home dashboard behind a MINIMAL loader — the person's name, every
// set-up checklist item as NOT done, and empty states for the data-bearing sections
// — while the full data-driven loader (E18-S08) extends this page once the feature
// data reads exist. The screen itself is the already-built, render-tested
// <DashboardView> (E18-S07), fed the five-item set-up checklist from the ONE pure
// module @/domain/home/checklist (E18-S03) — this task hard-codes none of them.
//
// WHY a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file
// may export ONLY its framework fields (its default page component), so it cannot
// carry an injectable, unit-testable seam without breaking `next build`. The thin
// protected-page loader (`page.tsx`) reads the session cookie + the process-wide
// database and renders the view; the testable logic — turning the verified session
// into the dashboard's props — lives in the plain sibling module `actions.ts` (the
// convention's `createXHandler({ db })` factory, here `createHomeActions({ db })`,
// exactly as the sibling security page uses `createSecurityActions({ db })`). These
// tests drive that factory directly against an isolated in-memory PGlite with the
// REAL migrations (src/test/db) and the REAL session/user seams, so no test touches
// the network or Azure, and none asserts on the source text of any module — a later
// behaviour-preserving refactor (a rename, a moved import) stays green.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createHomeActions(deps: { db: Db }): {
//     load(session: Session): Promise<DashboardViewProps>
//   }
//
//   • `load` takes the person's VERIFIED Session and derives the acting user id from
//     `session.userId` — never from a client-supplied value (design §5: every
//     member-scoped read takes the user id from the session). It reads that person's
//     account to name them, and assembles the dashboard's props:
//       - personName : names the signed-in person (the only plaintext identity an
//                       account has this early is its email, so the greeting is drawn
//                       from it — the real low-tier name arrives with E18-S08).
//       - checklist  : the five first-run set-up items, EVERY ONE not done
//                       (computeSetupChecklist({}) — the single source of the five
//                       labels/links; this task hard-codes none).
//       - pendingApprovals / activity / agents / reminders : the EMPTY states
//                       (0 and empty lists), so each data-bearing section renders a
//                       plain message rather than a dead control.
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC2  a signed-in GET /home returns 200 showing the person's name and the five
//        set-up checklist item titles (Get notified, About you, Add a card, Connect a
//        service, Connect an agent) — the loader's props, and the <DashboardView> the
//        page mounts over them, carry exactly that.
//   AC1 / AC3 [obligation:admin-auth-required]  an unauthenticated GET /home redirects
//        to /signin, and more generally an unauthenticated request to any admin route
//        is rejected toward sign-in while a public route returns 200 with no auth.
//        `/home` is mounted INSIDE the already-guarded `(protected)` route group, whose
//        layout delegates the admit/redirect decision to the central `requireSession`
//        seam (the one place identity is read, from the `__Host-wh_session` cookie
//        alone). These tests exercise that same guard — the one the newly-mounted route
//        sits behind — rather than re-deriving a parallel check.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb(). We render the view with `react-dom/server` (no
// DOM/jsdom — React component / E2E testing is a per-job ADR) and read the emitted
// markup, exactly as dashboard-view.test.tsx does.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createHomeActions } from "./actions";

import { DashboardView } from "@/components/home/dashboard-view";
import { computeSetupChecklist } from "@/domain/home/checklist";
import { requireSession } from "@/server/auth/guard";
import { createSession, type Session } from "@/server/auth/session";
import { createUser, type User } from "@/server/db/users";
import { createProtectedResourceMetadataHandler } from "@/app/.well-known/oauth-protected-resource/handler";
import { loadConfig } from "@/server/config";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// A frozen instant used as "now": a session created at T0 and read at T0 is
// comfortably inside both expiry windows, with no wall-clock dependence.
const T0 = new Date("2026-06-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);

// The five set-up checklist titles the acceptance criterion names, verbatim.
const SET_UP_TITLES = [
  "Get notified",
  "About you",
  "Add a card",
  "Connect a service",
  "Connect an agent",
] as const;

// --- the view model the loader returns -----------------------------------------
// Derived from the function itself so the test pins the BEHAVIOURAL fields without
// locking the props type's NAME (the guard tests take the same approach).
type HomeView = Awaited<ReturnType<ReturnType<typeof createHomeActions>["load"]>>;

// Build the home loader under test with the real db seam.
function makeActions(db: Db) {
  return createHomeActions({ db });
}

// Create a real person row (the account every member-scoped row hangs off). The
// wrapped DEK is opaque here — we never unwrap it — so any stable reference serves.
async function createPerson(db: Db, email: string): Promise<User> {
  return createUser(db, {
    email,
    wrappedDek: Buffer.from(`wrapped-dek-${email}`).toString("base64"),
  });
}

// Seed a signed-in person: a real account plus a live session for them. Returns the
// user, the verified Session the loader consumes, and the raw cookie token the guard
// would receive.
async function seedSignedIn(
  db: Db,
  email: string,
): Promise<{ user: User; session: Session; token: string }> {
  const user = await createPerson(db, email);
  const created = await createSession(db, user.id, { clock, random: systemRandom });
  return { user, session: created.session, token: created.token };
}

// --- markup helpers (no DOM), mirrored from dashboard-view.test.tsx --------------

function render(view: HomeView): string {
  return renderToStaticMarkup(<DashboardView {...view} />);
}

// Visible text with tags stripped: exactly the words a sighted reader sees (an
// <svg> icon contributes none). Decodes the entities that matter.
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Count the anchors in the markup that point at a given href.
function anchorsTo(markup: string, href: string): number {
  let n = 0;
  for (const m of markup.matchAll(/<a\b([^>]*)>/gi)) {
    const h = m[1]!.match(/\bhref="([^"]*)"/i);
    if (h && h[1] === href) n += 1;
  }
  return n;
}

// Assert the guard rejected, and return where it sent the request.
function redirectOf(result: Awaited<ReturnType<typeof requireSession>>): string {
  if (result.ok) {
    assert.fail("expected an unauthenticated request to be rejected, but a session was admitted");
  }
  return result.redirectTo;
}

// A validated config whose public base URL the public metadata route echoes (the
// repo's test-only secret values let loadConfig succeed).
function configWithBaseUrl(publicBaseUrl: string) {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: publicBaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

// ===========================================================================
// AC2 — a signed-in /home mounts the dashboard behind the minimal loader
// ===========================================================================

// The loader's props: the person named, the five set-up items all NOT done, and the
// data-bearing sections EMPTY. A distinctive, separator-free, digit-free local part
// ("quokkaxylophone") so the name can be found however the builder draws it from the
// account (whole email, local part, or title-cased) and can't collide with any
// checklist/empty-state copy.
test("the loader names the signed-in person and marks every set-up item not done, with empty states", async () => {
  const db = await freshDb();
  try {
    const { session } = await seedSignedIn(db, "quokkaxylophone@people.example");
    const view = await makeActions(db).load(session);

    // The person is named (the greeting's source — see header).
    assert.ok(
      view.personName.toLowerCase().includes("quokkaxylophone"),
      `the loader must name the signed-in person, got personName="${view.personName}"`,
    );

    // The checklist is the five first-run items, EVERY one not done — tied to the one
    // source of the labels/links (this task hard-codes none of them).
    assert.deepEqual(
      view.checklist,
      computeSetupChecklist({}),
      "the set-up checklist must be the five items, all not done (computeSetupChecklist({}))",
    );
    assert.equal(view.checklist.length, 5, "the checklist shows all five set-up items");
    assert.ok(
      view.checklist.every((item) => item.done === false),
      "every set-up checklist item must be NOT done on a freshly signed-up account",
    );

    // Empty states: nothing pending, and no activity / agents / reminders yet.
    assert.equal(view.pendingApprovals, 0, "a fresh account has no pending approvals");
    assert.deepEqual(view.activity, [], "a fresh account has no recent activity");
    assert.deepEqual(view.agents, [], "a fresh account has no connected agents");
    assert.deepEqual(view.reminders, [], "a fresh account has no reminders");
  } finally {
    await db.close();
  }
});

// AC2 — the screen a signed-in GET /home actually renders (the 200 body): the
// <DashboardView> the page mounts over the loader's props shows the person's name
// and every one of the five set-up checklist titles the AC names.
test("a signed-in /home renders the person's name and the five set-up checklist titles", async () => {
  const db = await freshDb();
  try {
    const { session } = await seedSignedIn(db, "quokkaxylophone@people.example");
    const markup = render(await makeActions(db).load(session));
    const text = strip(markup).toLowerCase();

    assert.ok(text.includes("quokkaxylophone"), "the home screen greets the signed-in person by name");
    for (const title of SET_UP_TITLES) {
      assert.ok(
        text.includes(title.toLowerCase()),
        `the home screen must show the set-up item "${title}", got: "${text}"`,
      );
    }

    // No dead control: with nothing pending the approvals section is a plain message,
    // never a count-link to the inbox (within this screen /inbox is only the approvals
    // widget, so the absence is scoped to the unit under test).
    assert.equal(
      anchorsTo(markup, "/inbox"),
      0,
      "with no pending approvals the home screen must not render a count-link to /inbox",
    );
  } finally {
    await db.close();
  }
});

// Security (design §5 — every member-scoped read takes the user id from the SESSION,
// never a client value): the greeting names the session's OWN person, never another
// account that happens to exist.
test("the loader names the session's own person, never another account", async () => {
  const db = await freshDb();
  try {
    const mine = await seedSignedIn(db, "quokkaxylophone@people.example");
    await seedSignedIn(db, "narwhalbaritone@people.example"); // a second, unrelated account

    const view = await makeActions(db).load(mine.session);
    const name = view.personName.toLowerCase();

    assert.ok(name.includes("quokkaxylophone"), "the loader names the session's own person");
    assert.ok(
      !name.includes("narwhalbaritone"),
      `the loader must never name another account, got personName="${view.personName}"`,
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 / AC3 [obligation:admin-auth-required] — /home is behind the central guard
// ===========================================================================
//
// `/home` lives inside the `(protected)` route group, whose layout delegates the
// admit/redirect decision to `requireSession`. These exercise that same guard — the
// one the newly-mounted route sits behind.

test("an unauthenticated GET /home (no session cookie) is redirected to /signin [admin-auth-required]", async () => {
  const db = await freshDb();
  try {
    const to = redirectOf(await requireSession(null, { db, clock }));
    assert.match(to, /signin/, `an absent session must be sent to sign-in, got ${to}`);
  } finally {
    await db.close();
  }
});

test("an unknown session token is rejected toward sign-in, a valid session admits the person [admin-auth-required]", async () => {
  const db = await freshDb();
  try {
    const unknown = redirectOf(await requireSession("not-a-real-token", { db, clock }));
    assert.match(unknown, /signin/, `an unknown session must be sent to sign-in, got ${unknown}`);

    const { user, token } = await seedSignedIn(db, "quokkaxylophone@people.example");
    const admitted = await requireSession(token, { db, clock });
    assert.equal(admitted.ok, true, "a valid session must be admitted to the admin area");
    assert.equal(
      admitted.ok && admitted.session.userId,
      user.id,
      "the admitted session must carry the person's own user id (identity from the session, not the client)",
    );
  } finally {
    await db.close();
  }
});

test("a public route returns HTTP 200 with no auth header or session [admin-auth-required]", async () => {
  // A genuinely public route (the protected-resource metadata) stays usable with no
  // authentication (INV-101). The real handler, invoked with a request carrying no
  // Authorization header and no session cookie.
  const handler = createProtectedResourceMetadataHandler({
    config: configWithBaseUrl("https://warthog.example"),
  });
  const response = await handler(
    new Request("https://warthog.example/.well-known/oauth-protected-resource"),
  );
  assert.equal(response.status, 200, "a public route must be served with no auth");
});
