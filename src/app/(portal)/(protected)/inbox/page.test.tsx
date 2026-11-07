// E12-S13 — Inbox page loader and wiring (`src/app/(portal)/(protected)/inbox/`).
//
// RED-first: the inbox LOADER seam does NOT exist yet. `createInboxActions` already
// exists (E12-S10) and returns { approveApproval, denyApproval, askForMoreDetail }; this
// task adds a `load(session)` method to that SAME factory (the activity/home/security
// pattern — one factory with `load` alongside its mutations). Until the builder adds
// `load`, every test here fails at `actions.load(...)` ("load is not a function"). That
// absence IS the point of test-first — do NOT implement anything to make these pass; the
// builder writes the loader afterwards as the minimum code that turns these green.
//
// Why these tests live in a SIBLING of `page.tsx`: a Next `page.tsx` entry file may
// export ONLY its framework fields (its default page component), so the injectable,
// unit-testable loader logic can't live there without breaking `next build`. The thin
// `page.tsx` reads the signed-in session from the host-locked session cookie + the
// process-wide database, calls this seam to turn the verified session into the view's
// props, binds the three decision server actions + the device release trigger, and
// renders `<InboxView>`. The testable logic lives in the plain sibling module `./actions`
// (the convention's `createXActions(deps)` factory), so these tests drive it directly
// against an isolated in-memory PGlite with the REAL migrations (`@/test/db`), the REAL
// approvals store / inbox read / opened-tracking primitives, a real `KeyWrapper` and the
// real cards + high-tier stores — no test touches the network or Azure, and none asserts
// on the source text of any module, so a later behaviour-preserving refactor stays green.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createInboxActions(deps: { db; clock; keyWrapper; executeApprovedHold }): {
//     approveApproval, denyApproval, askForMoreDetail,   // existing (E12-S10)
//     load(session: Session): Promise<InboxViewProps-data>   // NEW
//   }
//
//   `load`:
//     • reads ONLY the session user's approvals (member-scoped by `session.userId`, NEVER
//       a client value — CLAUDE.md member scope / design §5) and returns the data the
//       frozen <InboxView> (E12-S12) consumes: `pending` (newest-first), `history`, and
//       the person's `savedCards` (brand + last four label + the device-decryptable
//       ciphertext) a card release's picker needs. It resolves the session person's DEK
//       (getUserById + keyWrapper.unwrap) so the approvals store can decrypt the detail,
//       and the time-left on each pending request comes from the injected clock;
//     • maps each pending request's `release` kind from its decrypted `detail.request`
//       (`card` / `high_tier` → a device-release Approve path; otherwise `null` → a plain
//       server-verified Approve) — the SAME discriminator approveApproval uses; and
//     • marks every pending approval it shows OPENED (member-scoped markOpened), so the
//       SMS/email fallback — which fires only while an approval is unopened AND pending —
//       is suppressed once the person has viewed their inbox.
//
//   The page binds the decision controls separately when it renders (exactly as the
//   activity page binds Dispute): `<InboxView {...load(session)} approveAction={…}
//   denyAction={…} moreDetailAction={…} onRelease={…} />`. These tests render the view
//   the same way to prove the loader's data mounts LIVE controls carrying the ids the
//   bound actions consume.
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's pending approvals (newest-first) + their
//        history, maps each release kind, reads the saved cards a release needs, and its
//        data mounts <InboxView> with LIVE approveApproval / denyApproval / askForMoreDetail
//        controls that carry the approval id.
//   AC2  viewing an approval marks it opened, so its fallback is suppressed (the opened
//        flag is set, and the fallback's `isUnopened` guard then reports false).
//   AC3  a user never sees another user's approvals — and viewing their own inbox never
//        marks another user's approval opened (the view write is member-scoped too).
//
// The loader is READ-ONLY: it must never run a held call while rendering the inbox, so the
// `executeApprovedHold` seam handed to the factory THROWS if the loader ever calls it.
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`. The view
// is rendered with `react-dom/server` (no DOM/jsdom — React component / E2E testing is a
// per-job ADR), exactly as the sibling activity page.test.tsx and inbox-view.test.tsx do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createInboxActions } from "./actions";

import {
  InboxView,
  type PendingRequestView,
  type DecidedRequestView,
  type SavedCardView,
} from "@/components/inbox/inbox-view";
import { createApproval, decide } from "@/server/db/approvals";
import { createHeldRequest, getByApproval } from "@/server/db/held-requests";
import { listActivity } from "@/server/activity/list";
import { loadConfig, type Config } from "@/server/config";
import { addCard } from "@/server/db/cards";
import { saveHighTierField } from "@/server/db/high-tier-fields";
import { isUnopened } from "@/server/approvals/opened";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// A frozen "now" the loader reads time (time-left, opened_at) through; created approvals
// sit a minute or two earlier so they are still comfortably inside their 15-minute window.
const NOW = new Date("2026-11-15T12:00:00.000Z");
const T_OLD = new Date("2026-11-15T11:58:00.000Z");
const T_NEW = new Date("2026-11-15T11:59:00.000Z");
const T_SEED = new Date("2026-11-15T11:50:00.000Z");
const T_DECIDED = new Date("2026-11-15T11:55:00.000Z");

const ms = (value: Date | string | number): number => new Date(value as never).getTime();

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// The shape `load` returns — the data slice of <InboxView>'s props (the page adds the
// bound decision actions when it renders). Declared here so the tests read cleanly; the
// builder's own return type conforms to it.
type LoadedInbox = {
  pending: readonly PendingRequestView[];
  history: readonly DecidedRequestView[];
  savedCards?: readonly SavedCardView[];
};

// The factory WITH the loader this task adds. Cast so the tests express the intended
// contract; at runtime `.load` is absent until the builder implements it (the RED), so
// every test fails at the call with "load is not a function".
type InboxActionsWithLoad = ReturnType<typeof createInboxActions> & {
  load(session: Session): Promise<LoadedInbox>;
};

// Build the inbox actions over the real seams. `executeApprovedHold` THROWS: the loader
// only READS the inbox, so it must never run a held call while rendering — if it did,
// this surfaces it loudly rather than silently executing something.
function makeActions(db: Db, keyWrapper: KeyWrapper, clock: Clock): InboxActionsWithLoad {
  const executeApprovedHold = async (): Promise<never> => {
    throw new Error("the inbox loader must not execute a held call — it only reads");
  };
  return createInboxActions({ db, clock, keyWrapper, executeApprovedHold }) as InboxActionsWithLoad;
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper` (the resolution path
// the loader uses: getUserById + keyWrapper.unwrap), returning their id and the DEK their
// approval detail is encrypted under.
async function makePerson(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

// The decrypted approval `detail` the inbox shows: a plain-language sentence, the exact
// recipient / amount / field, the stated reason and the triggering rule, plus the
// `request` discriminator ("card" / "high_tier" marks a release; omitted → a routine held
// call). `undefined` fields drop out of the stored JSON, so omitting `request` is a
// routine held call exactly as production stores it.
function detailFor(opts: {
  sentence?: string;
  reason?: string;
  rule?: string;
  recipient?: string;
  amount?: string;
  field?: string;
  request?: "card" | "high_tier";
}): Record<string, unknown> {
  return {
    sentence: opts.sentence ?? "wants to do something on your behalf",
    reason: opts.reason ?? "it was asked to",
    rule: opts.rule ?? "Ask me first",
    recipient: opts.recipient,
    amount: opts.amount,
    field: opts.field,
    request: opts.request,
  };
}

// Seed one PENDING approval for `userId`, created at `at`, with its detail DEK-encrypted —
// the exact production shape (the approvals store the pipeline writes through).
async function seedPending(
  db: Db,
  input: { userId: string; dek: Uint8Array; detail: Record<string, unknown>; at?: Date },
): Promise<string> {
  const created = await createApproval(
    db,
    { userId: input.userId, agentId: randomUUID(), detail: input.detail, expiryMinutes: 15 },
    input.dek,
    fixedClock(input.at ?? T_SEED),
  );
  return created.id;
}

// Seed one DECIDED approval (created, then moved to a terminal status) — the person's
// decision history.
async function seedDecided(
  db: Db,
  input: {
    userId: string;
    dek: Uint8Array;
    detail: Record<string, unknown>;
    decision: Parameters<typeof decide>[1]["decision"];
  },
): Promise<string> {
  const created = await createApproval(
    db,
    { userId: input.userId, agentId: randomUUID(), detail: input.detail, expiryMinutes: 15 },
    input.dek,
    fixedClock(T_SEED),
  );
  await decide(
    db,
    { userId: input.userId, id: created.id, decision: input.decision },
    input.dek,
    fixedClock(T_DECIDED),
  );
  return created.id;
}

// A real verified session for `userId` — the loader reads `session.userId` from it.
async function sessionFor(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock: fixedClock(NOW), random: systemRandom });
  return created.session;
}

// The `opened_at` stamp on an approval, member-scoped — a direct row-level probe so the
// "marked opened" claim is checked independently of any read path.
async function openedAt(db: Db, userId: string, id: string): Promise<Date | null> {
  const r = await db.query("SELECT opened_at FROM approvals WHERE id = $1 AND user_id = $2", [id, userId]);
  const value = r.rows[0]?.opened_at;
  return value == null ? null : new Date(value as string | number | Date);
}

// --- markup helpers (no DOM), mirrored from the sibling component/page tests -----------

type BoundActions = {
  approveAction?: (fd: FormData) => void | Promise<void>;
  denyAction?: (fd: FormData) => void | Promise<void>;
  moreDetailAction?: (fd: FormData) => void | Promise<void>;
  onRelease?: (request: PendingRequestView) => void | Promise<void>;
};

const noopAction = async (_fd: FormData): Promise<void> => {};
const noopRelease = async (_request: PendingRequestView): Promise<void> => {};

// Render the mounted screen the page shows over the loader's data: spread the loader's
// props and bind the decision actions, exactly as `page.tsx` does.
function renderInbox(view: LoadedInbox, actions: BoundActions = {}): string {
  return renderToStaticMarkup(<InboxView {...view} {...actions} />);
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

function inputAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push(m[1]!);
  return out;
}

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// React server-renders a FUNCTION form action (a bound server action) as a `javascript:`
// progressive-enhancement placeholder; a disabled/dead control carries no such form. So
// "this control is BOUND to a server action" is observable as the form's action scheme —
// behaviour, not source text (the same probe inbox-view.test.tsx uses).
function isBoundToAction(form: El): boolean {
  const action = attr(form.attrs, "action");
  return action !== null && /^javascript:/i.test(action);
}

// Whether `form` carries `id` under SOME hidden field (the builder picks the field name —
// id / approvalId / …; the test reads whichever hidden field carries the request id).
function formCarriesId(form: El, id: string): boolean {
  for (const a of inputAttrs(form.inner)) {
    if (attr(a, "type") === "hidden" && attr(a, "value") === id) return true;
  }
  return false;
}

// Whether `markup` carries a free-text entry field (a <textarea>, or a free-text <input>) —
// the "say why" field an Ask-for-more-detail form offers, which Approve/Deny do not.
const FREE_TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", ""]);
function hasFreeTextField(markup: string): boolean {
  if (findAll(markup, "textarea").length > 0) return true;
  return inputAttrs(markup).some((a) => FREE_TEXT_TYPES.has((attr(a, "type") ?? "").toLowerCase()));
}

// The decision-control matchers — generous over the plausible plain wordings (the copy is
// the builder's to word), the same set inbox-view.test.tsx uses.
const APPROVE_RE = /approve|allow|hand over/i;
const DENY_RE = /deny|turn down|decline|refuse|reject|say no/i;
// The proceed/confirm control that runs the on-device release, and the sensitive-moment
// explainer that accompanies it (mirrored from inbox-view.test.tsx / release-approve.test.tsx).
const RELEASE_RE = /release|hand over|hand it|share|confirm|continue/i;
const EXPLAINER_RE =
  /sensitive|take a moment|moment before|before it goes ahead|check the details|double.?check|one[- ]?time|slow down/i;

// The accessible name of a control: its visible text PLUS any aria-label / title.
function controlFace(el: El): string {
  const parts = [visibleText(el.inner)];
  const al = attr(el.attrs, "aria-label");
  if (al) parts.push(al);
  const ti = attr(el.attrs, "title");
  if (ti) parts.push(ti);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isDisabled(el: El): boolean {
  return /\bdisabled\b/i.test(el.attrs);
}

// Every LIVE control (a <button> or a disclosure <summary>, not disabled) whose accessible
// name matches `re` — so "offers a live release control" never bets on the element kind.
function liveControlsMatching(markup: string, re: RegExp): El[] {
  return [...findAll(markup, "button"), ...findAll(markup, "summary")].filter(
    (c) => re.test(controlFace(c)) && !isDisabled(c),
  );
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's pending (newest-first) + history.
// =====================================================================================

test("the loader returns the session person's pending approvals newest-first, and their decision history", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");

    const older = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to tidy your calendar" }),
      at: T_OLD,
    });
    const newer = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to reply to a message" }),
      at: T_NEW,
    });
    const decided = await seedDecided(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "renamed a shared folder" }),
      decision: { status: "approved" },
    });

    const view = await makeActions(db, keyWrapper, fixedClock(NOW)).load(await sessionFor(db, alice.userId));

    // Pending: both of Alice's, newest-created first (never the decided one).
    assert.deepEqual(
      view.pending.map((p) => p.id),
      [newer, older],
      "pending lists the person's pending approvals newest-first",
    );
    assert.ok(
      !view.pending.some((p) => p.id === decided),
      "a decided approval is never in the pending list",
    );

    // History: the decided one is there; the still-pending ones are not.
    const historyIds = view.history.map((h) => h.id);
    assert.ok(historyIds.includes(decided), "the decided approval is in the history");
    assert.ok(
      !historyIds.includes(older) && !historyIds.includes(newer),
      "a pending approval is never in the history",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the loader's data mounts <InboxView> with LIVE Approve / Deny / Ask controls,
// each bound to the server action the page passes and carrying the approval id.
// =====================================================================================

test("the loaded inbox mounts live Approve, Deny and Ask-for-more-detail controls that carry the approval id", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    // A routine (non-release) held call — its Approve is a plain server-verified decision
    // bound to approveApproval (a release's Approve is the device flow, tested separately).
    const id = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to send a note to your book club" }),
      at: T_NEW,
    });

    const view = await makeActions(db, keyWrapper, fixedClock(NOW)).load(await sessionFor(db, alice.userId));

    // The page binds the three decision server actions; render the mounted screen.
    const markup = renderInbox(view, {
      approveAction: noopAction,
      denyAction: noopAction,
      moreDetailAction: noopAction,
      onRelease: noopRelease,
    });
    const forms = findAll(markup, "form");

    // Ask-for-more-detail is the bound form carrying a free-text question field; Approve
    // and Deny are bound forms with only the hidden id (no free-text field).
    const askForms = forms.filter((f) => isBoundToAction(f) && hasFreeTextField(f.inner));
    const approveForms = forms.filter(
      (f) => isBoundToAction(f) && !hasFreeTextField(f.inner) && APPROVE_RE.test(visibleText(f.inner)),
    );
    const denyForms = forms.filter(
      (f) => isBoundToAction(f) && !hasFreeTextField(f.inner) && DENY_RE.test(visibleText(f.inner)),
    );

    assert.equal(approveForms.length, 1, "a live Approve control (bound to approveApproval) is mounted");
    assert.ok(formCarriesId(approveForms[0]!, id), "the Approve control carries the approval id it decides");

    assert.equal(denyForms.length, 1, "a live Deny control (bound to denyApproval) is mounted");
    assert.ok(formCarriesId(denyForms[0]!, id), "the Deny control carries the approval id it decides");

    assert.equal(askForms.length, 1, "a live Ask-for-more-detail control (bound to askForMoreDetail) is mounted");
    assert.ok(formCarriesId(askForms[0]!, id), "the Ask control carries the approval id it asks about");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the loader maps each pending request's release kind from its detail: a card /
// high-tier request takes the device-release Approve path; a routine held call does not.
// (This is the SAME `detail.request` discriminator approveApproval uses to gate step-up.)
// =====================================================================================

test("the loader maps each pending request's release kind from its detail (none / card / high_tier)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");

    // A high-tier field + a saved card exist (the "targets a release needs" a release reads).
    await saveHighTierField(db, {
      userId: alice.userId,
      type: "passport",
      label: "Passport",
      ciphertext: "v1:passportCipher",
    });
    await addCard(db, {
      userId: alice.userId,
      brand: "Visa",
      lastFour: "4242",
      expiryMonth: 11,
      expiryYear: 2030,
      nickname: "Everyday",
      billingAddressId: "addr-1",
      numberCiphertext: "v1:visaCipher",
    });

    const held = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to post to a group" }),
      at: T_OLD,
    });
    const card = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to use a card", request: "card", amount: "42.00 AUD" }),
      at: new Date(T_OLD.getTime() + 30_000),
    });
    const high = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants your passport number", request: "high_tier", field: "passport" }),
      at: T_NEW,
    });

    const view = await makeActions(db, keyWrapper, fixedClock(NOW)).load(await sessionFor(db, alice.userId));
    const releaseById = new Map(view.pending.map((p) => [p.id, p.release]));

    assert.equal(releaseById.get(held), null, "a routine held call is not a release (plain Approve path)");
    assert.equal(releaseById.get(card), "card", "a card request is mapped to a card release");
    assert.equal(releaseById.get(high), "high_tier", "a high-tier request is mapped to a high-tier release");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the loader reads the person's saved cards (brand + last four label + the
// device-decryptable ciphertext) so a card release's picker can offer them.
// =====================================================================================

test("the loader reads the person's saved cards — label and device ciphertext — for a card release's picker", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");

    const visa = await addCard(db, {
      userId: alice.userId,
      brand: "Visa",
      lastFour: "4242",
      expiryMonth: 11,
      expiryYear: 2030,
      nickname: "Everyday",
      billingAddressId: "addr-1",
      numberCiphertext: "v1:visaCipherFerry",
    });
    const amex = await addCard(db, {
      userId: alice.userId,
      brand: "Amex",
      lastFour: "1005",
      expiryMonth: 7,
      expiryYear: 2029,
      nickname: "Travel",
      billingAddressId: "addr-2",
      numberCiphertext: "v1:amexCipherFerry",
    });
    const cipherById: Record<string, string> = {
      [visa.id]: "v1:visaCipherFerry",
      [amex.id]: "v1:amexCipherFerry",
    };

    // A card release is pending, so the picker is in play.
    await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to use a card to pay the fare", request: "card", amount: "42.00 AUD" }),
      at: T_NEW,
    });

    const view = await makeActions(db, keyWrapper, fixedClock(NOW)).load(await sessionFor(db, alice.userId));
    const saved = view.savedCards ?? [];

    for (const card of [visa, amex]) {
      const match = saved.find((c) => c.id === card.id);
      assert.ok(match, `the saved card ${card.brand} is offered in the picker`);
      assert.equal(
        match!.ciphertext,
        cipherById[card.id],
        "the device-decryptable number ciphertext is carried (the device needs it to release)",
      );
      assert.ok(
        match!.label.includes(card.brand) && match!.label.includes(card.lastFour),
        `the card label shows brand + last four (got "${match!.label}")`,
      );
      assert.ok(
        !match!.label.includes("Cipher"),
        "the label is display metadata (brand + last four), never the stored number ciphertext",
      );
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// E11-S17 (BEHAVIOUR SUPERSESSION for this file) — the page now mounts the on-device
// release control for release requests. Until E11-S17 the page passed no release trigger
// and the view rendered a card/high-tier release's "Approve and release" DISABLED with a
// reason (a signed-in server page cannot hand a React client a callback). This task mounts
// the self-wired on-device <ReleaseApprove> control, so a loaded card release renders a
// LIVE release control — the on-device unlock-decrypt-release — bound to nothing the server
// page supplies. The page still binds the three decision server actions exactly as before.
//
// Rendered exactly as page.tsx renders it: the loader's props spread, the three decision
// actions bound, and NO release trigger — so a live release control proves the view mounts
// the on-device control itself (RED against the pre-S17 disabled-with-reason rendering).
// =====================================================================================

test("a loaded card release mounts a LIVE on-device release control (not a disabled 'Approve and release')", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");

    // A saved card exists (the picker the release offers) ...
    await addCard(db, {
      userId: alice.userId,
      brand: "Visa",
      lastFour: "4242",
      expiryMonth: 11,
      expiryYear: 2030,
      nickname: "Everyday",
      billingAddressId: "addr-1",
      numberCiphertext: "v1:visaCipherFerry",
    });
    // ... and a card release is pending.
    const cardRelease = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to use a card to pay the fare", request: "card", amount: "42.00 AUD" }),
      at: T_NEW,
    });

    const view = await makeActions(db, keyWrapper, fixedClock(NOW)).load(await sessionFor(db, alice.userId));

    // Exactly page.tsx's wiring: the three decision server actions, and NO release trigger.
    const markup = renderInbox(view, {
      approveAction: noopAction,
      denyAction: noopAction,
      moreDetailAction: noopAction,
    });

    const live = liveControlsMatching(markup, RELEASE_RE);
    assert.ok(
      live.length >= 1,
      `a loaded card release must mount a LIVE on-device release control, got controls: ${JSON.stringify(
        [...findAll(markup, "button"), ...findAll(markup, "summary")].map((c) => ({
          face: controlFace(c),
          disabled: isDisabled(c),
        })),
      )}`,
    );
    assert.match(
      visibleText(markup),
      EXPLAINER_RE,
      "the mounted on-device release shows the sensitive-moment explainer",
    );
    assert.ok(markup.includes(cardRelease), "the mounted release control belongs to the pending card release");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — viewing an approval marks it opened, so its SMS/email fallback is suppressed. The
// fallback fires ONLY while an approval is unopened AND pending (opened.isUnopened); once
// the person has viewed their inbox the loader has set opened_at, so the guard is false.
// =====================================================================================

test("viewing the inbox marks each pending approval opened, suppressing its fallback", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const a = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to schedule a reminder" }),
      at: T_OLD,
    });
    const b = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to archive an email" }),
      at: T_NEW,
    });

    // Before viewing: both are unopened + pending, so the fallback is still armed.
    for (const id of [a, b]) {
      assert.equal(await isUnopened(db, id), true, "the approval's fallback is armed before it is viewed");
      assert.equal(await openedAt(db, alice.userId, id), null, "it is unopened before the view");
    }

    await makeActions(db, keyWrapper, fixedClock(NOW)).load(await sessionFor(db, alice.userId));

    // After viewing: each shown pending approval is opened (opened_at = the loader's clock),
    // so its fallback is suppressed.
    for (const id of [a, b]) {
      assert.equal(
        await isUnopened(db, id),
        false,
        "viewing the inbox suppresses the fallback (the approval is no longer unopened)",
      );
      const stamp = await openedAt(db, alice.userId, id);
      assert.notEqual(stamp, null, "the approval is marked opened when it is viewed");
      assert.equal(ms(stamp!), ms(NOW), "opened_at is stamped from the loader's injected clock");
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a person never sees another person's approvals, and viewing their OWN inbox never
// marks another person's approval opened (the view write is member-scoped by the session
// user id, never a client value). CLAUDE.md: every member-scoped task has an ownership test.
// =====================================================================================

test("a person never sees another person's approvals, and viewing their own inbox never opens another's", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");

    const alicePending = await seedPending(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "wants to book an Alice appointment" }),
      at: T_NEW,
    });
    const aliceDecided = await seedDecided(db, {
      userId: alice.userId,
      dek: alice.dek,
      detail: detailFor({ sentence: "sent an Alice note" }),
      decision: { status: "denied" },
    });

    // Bob's own pending + decided approvals (encrypted under Bob's own DEK).
    const bobPending = await seedPending(db, {
      userId: bob.userId,
      dek: bob.dek,
      detail: detailFor({ sentence: "wants to book a Bob appointment" }),
      at: T_NEW,
    });
    const bobDecided = await seedDecided(db, {
      userId: bob.userId,
      dek: bob.dek,
      detail: detailFor({ sentence: "sent a Bob note" }),
      decision: { status: "approved" },
    });

    const view = await makeActions(db, keyWrapper, fixedClock(NOW)).load(await sessionFor(db, alice.userId));

    // The returned data holds only Alice's approvals — never any of Bob's, in either list.
    const shownIds = [...view.pending, ...view.history].map((x) => x.id);
    assert.ok(shownIds.includes(alicePending), "Alice sees her pending approval");
    assert.ok(shownIds.includes(aliceDecided), "Alice sees her decided approval");
    assert.ok(!shownIds.includes(bobPending), "Alice never sees Bob's pending approval");
    assert.ok(!shownIds.includes(bobDecided), "Alice never sees Bob's decided approval");

    // Nothing of Bob's leaks into the serialised view either.
    assert.ok(
      !JSON.stringify(view).includes(bobPending) && !JSON.stringify(view).includes(bobDecided),
      "no returned entry carries another person's approval id",
    );

    // The mounted screen shows Alice's pending request (its id rides a decision control),
    // and never Bob's.
    const markup = renderInbox(view, {
      approveAction: noopAction,
      denyAction: noopAction,
      moreDetailAction: noopAction,
    });
    assert.ok(markup.includes(alicePending), "Alice's pending approval is on the screen");
    assert.ok(!markup.includes(bobPending), "Bob's approval is never on Alice's screen");

    // And viewing Alice's inbox must not have marked Bob's approval opened — his fallback
    // stays armed (markOpened is member-scoped by the session user id).
    assert.equal(await isUnopened(db, bobPending), true, "Bob's pending approval is still unopened after Alice's view");
    assert.equal(await openedAt(db, bob.userId, bobPending), null, "Alice's view never stamps Bob's approval opened");
    assert.equal(await isUnopened(db, alicePending), false, "Alice's own approval was opened by her view");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// E07-S20 — Approving a held call now EXECUTES it (wired through the MCP composition
// root) instead of reporting "approved-hold execution is not configured".
//
// BEHAVIOUR SUPERSESSION (declared by the plan for THIS file): until E07-S20 the inbox
// page handed `createInboxActions` a stub `executeApprovedHold` that THREW
// "approved-hold execution is not configured", so approving a held non-release call
// reported an error and the agent's call never ran. This task wires that seam to the
// real agent-call pipeline through the composition root, so approving a held non-release
// call runs it exactly once and its outcome shows in Activity.
//
// RED-first: the composition root does NOT export the executor factory yet, so
// `createAgentExecutors` is absent and this test fails at `composeExecutors(...)` — that
// absence IS the point of test-first. The builder adds the factory to
// `src/server/mcp/compose.ts` (within this task's Touches) and wires the page to it.
//
// The pinned contract (the builder implements exactly this, alongside the existing
// `createMcpDispatch`, which compose.test.ts locks to a dispatch function and MUST keep):
//
//   createAgentExecutors(deps: { db: Db; config: Config }): {
//     executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult>;
//     runReversal(job: { userId; reversalTool; originalSeq; reason? }): Promise<{ outcome: string }>;
//   }
//
// `executeApprovedHold` is the pipeline's own single-shot runner, built from { db, config }
// (the composition root's two inputs) — the SAME thing check_approval already runs an
// approved hold through. The user id is the CALLER's (the session's), never a form value.
//
// This drives the REAL pipeline end-to-end over an isolated PGlite with the real stores:
// a pending non-release approval + its linked held call are seeded exactly as the ask path
// parks them, then the page's own `approveApproval` (over the composed executor) runs it.
// It asserts BEHAVIOUR (the held request is consumed; the outcome lands in Activity once),
// never source text; the composition root is reached by its public export only.

// The pipeline's approved-hold result (pipeline.ts) — declared here so the test reads
// cleanly; the builder's own type conforms to it.
type ApprovedHoldResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string };

// The executor factory this task adds to the composition root (the pinned contract).
type AgentExecutors = {
  executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult>;
  runReversal(job: {
    userId: string;
    reversalTool: string;
    originalSeq: number;
    reason?: string;
  }): Promise<{ outcome: string }>;
};

// The composition-root module as this task widens it. The factory is OPTIONAL in the view
// so the file type-checks before the builder adds it; at runtime it is absent until then,
// so `composeExecutors` fails LOUDLY (RED) rather than silently passing. The module is
// loaded dynamically so this one unbuilt seam reddens only THIS test, not the whole file.
type ComposeModule = {
  createAgentExecutors?: (deps: { db: Db; config: Config }) => AgentExecutors;
};

async function composeExecutors(db: Db, config: Config): Promise<AgentExecutors> {
  const mod = (await import("../../../../server/mcp/compose")) as unknown as ComposeModule;
  assert.equal(
    typeof mod.createAgentExecutors,
    "function",
    "E07-S20: compose must export createAgentExecutors({ db, config }) → { executeApprovedHold, runReversal }",
  );
  return mod.createAgentExecutors!({ db, config });
}

// A dev config whose devKek is the local KEK the composition root derives its KeyWrapper
// from, so the DEK we wrap below is exactly what the composed executor unwraps.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");
function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
  } as NodeJS.ProcessEnv);
}

test("approving a held non-release call runs it once through the composed pipeline (not an 'is not configured' stub)", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const keyWrapper = localAesKeyWrapper(config.devKek!);
    const dek = randomBytes(DEK_BYTES);
    const user = await createUser(db, {
      email: `exec-${randomUUID()}@warthog.com.au`,
      wrappedDek: await keyWrapper.wrap(dek),
    });
    const agentId = randomUUID();
    const clock = fixedClock(NOW);

    // A PENDING non-release approval (no `detail.request`) and its linked held call — a
    // routine change (remember), parked exactly as the pipeline's ask path stores it.
    const approval = await createApproval(
      db,
      { userId: user.id, agentId, detail: detailFor({ sentence: "wants to jot a quick note" }) },
      dek,
      clock,
    );
    const marker = `held-${randomUUID()}`;
    await createHeldRequest(
      db,
      {
        userId: user.id,
        agentId,
        approvalId: approval.id,
        args: { connector: null, tool: "remember", makesChange: true, params: { content: marker } },
      },
      dek,
      clock,
    );

    const executors = await composeExecutors(db, config);
    const actions = createInboxActions({
      db,
      clock,
      keyWrapper,
      executeApprovedHold: executors.executeApprovedHold,
    });
    const session = await sessionFor(db, user.id);

    // Approve → the held call runs exactly once; the held request is consumed and Warthog
    // records the outcome in Activity. (It no longer reports "not configured".)
    const first = await actions.approveApproval(session, approval.id);
    assert.deepEqual(first, { ok: true }, "approving a held non-release call succeeds (it is wired, not an error)");

    const ranHold = await getByApproval(db, user.id, approval.id, dek);
    assert.equal(ranHold?.status, "executed", "the held request is consumed — the approved call ran once");

    const recorded = (await listActivity(db, user.id, {}, dek)).filter(
      (entry) => entry.tool === "remember" && entry.source === "warthog",
    );
    assert.equal(recorded.length, 1, "the approved held call's outcome is recorded in Activity exactly once");

    // Approving again does nothing more — the held call never runs twice (re-deciding an
    // already-approved approval is refused upstream, before the executor is reached again).
    await assert.rejects(
      () => actions.approveApproval(session, approval.id),
      "re-approving an already-decided approval is refused, not a second silent run",
    );
    const afterSecond = (await listActivity(db, user.id, {}, dek)).filter(
      (entry) => entry.tool === "remember" && entry.source === "warthog",
    );
    assert.equal(afterSecond.length, 1, "approving again runs nothing more (the held call ran only once)");
    assert.equal(
      (await getByApproval(db, user.id, approval.id, dek))?.status,
      "executed",
      "the held request stays executed after a second approve",
    );
  } finally {
    await db.close();
  }
});
