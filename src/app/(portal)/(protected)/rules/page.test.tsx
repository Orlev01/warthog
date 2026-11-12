// E12-S17 — Rules page loader and wiring (`src/app/(portal)/(protected)/rules/`).
//
// RED-first: the rules LOADER seam does NOT exist yet (the dir holds only a placeholder
// `page.tsx`), so importing `./actions` throws and every test here fails until the
// builder adds it. That absence IS the point of test-first — do NOT implement anything
// to make these pass; the builder writes the loader + the wired <RulesView> afterwards
// as the minimum code that turns these green.
//
// Why these tests live in a SIBLING of `page.tsx`: a Next `page.tsx` entry file may
// export ONLY its framework fields (its default page component), so the injectable,
// unit-testable loader logic can't live there without breaking `next build`. The thin
// `page.tsx` reads the signed-in session from the host-locked session cookie + the
// process-wide database, calls `createRulesActions(deps).load(session)` to turn the
// verified session into the <RulesView> data, binds the four rule server actions
// (createRule / updateRule / pauseRule / deleteRule) and renders `<RulesView>`. The
// testable logic lives in the plain sibling `./actions`, so these tests drive it
// directly against an isolated in-memory PGlite with the REAL migrations (`@/test/db`),
// the REAL rules + agents stores and a real `KeyWrapper` — no test touches the network
// or Azure, and none asserts on the source text of any module, so a later
// behaviour-preserving refactor stays green.
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's rules (member-scoped by session.userId,
//        NEVER a client value — CLAUDE.md member scope / design §5), active AND paused, each
//        read back as its exact plain sentence + lifecycle status, plus the person's own
//        agents (offered as the "chosen agents" scope). A user never sees another's rules.
//   AC1  the loaded data mounts <RulesView> wired to the four server actions: the create
//        form is bound to createRule and carries the named payload fields; each rule offers
//        a live Delete (bound to deleteRule) carrying its id, and each active rule a live
//        Pause (bound to pauseRule) carrying its id.
//
// The view is rendered with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR), exactly as the sibling inbox/activity page tests do. A
// bound server action is observable as the form's `javascript:` action scheme (React's
// progressive-enhancement placeholder for a function action) — behaviour, not source
// text. Every db handle is closed in a `finally`; each test uses its own `freshDb()`.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createRulesActions } from "./actions";

import { RulesView, type RulesViewRule, type RulesViewAgent } from "@/components/rules/rules-view";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

type RulesActions = ReturnType<typeof createRulesActions>;
// The shape `load` returns, derived from the factory's own signature so a later
// type rename that preserves behaviour does not redden these tests.
type LoadedRules = Awaited<ReturnType<RulesActions["load"]>>;

function makeActions(db: Db, keyWrapper: KeyWrapper, clock: Clock = fixedClock(NOW)): RulesActions {
  return createRulesActions({ db, clock, keyWrapper });
}

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

async function sessionFor(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock: fixedClock(NOW), random: systemRandom });
  return created.session;
}

// Valid rule inputs (the brief's vocabulary) a test seeds through createRule.
const ASK_FIRST_EMAIL = {
  kind: "ask_first",
  scope: { type: "any_agent" },
  action: { type: "send_message", channel: "email" },
};
const NEVER_ALLOW_CHANGE = {
  kind: "never_allow",
  scope: { type: "any_agent" },
  action: { type: "any_change" },
};
const ASK_FIRST_EMAIL_SENTENCE = "Ask me before any agent sends email";
const NEVER_ALLOW_CHANGE_SENTENCE = "Never allow any agent to make any change";

// --- the four bound server actions the page passes (optional on the view). ------------
type RuleAction = (formData: FormData) => void | Promise<void>;
type BoundRulesActions = {
  createAction?: RuleAction;
  updateAction?: RuleAction;
  pauseAction?: RuleAction;
  deleteAction?: RuleAction;
};
const noopAction = async (_fd: FormData): Promise<void> => {};

// Render the mounted screen the page shows over the loader's data, binding the four
// rule server actions exactly as `page.tsx` does. Passing all four as DIRECT attributes
// pins the wiring contract: <RulesView> must declare each action prop.
function renderRules(view: LoadedRules, actions: BoundRulesActions = {}): string {
  return renderToStaticMarkup(
    <RulesView
      rules={view.rules}
      agents={view.agents}
      createAction={actions.createAction}
      updateAction={actions.updateAction}
      pauseAction={actions.pauseAction}
      deleteAction={actions.deleteAction}
    />,
  );
}

// --- markup helpers (no DOM), mirrored from the sibling inbox/activity page tests ------

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

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// React server-renders a FUNCTION form action (a bound server action) as a `javascript:`
// progressive-enhancement placeholder; a form with no bound action carries none. So
// "this form is BOUND to a server action" is observable as its action scheme.
function isBoundToAction(form: El): boolean {
  const action = attr(form.attrs, "action");
  return action !== null && /^javascript:/i.test(action);
}

// Whether `form` carries `id` under SOME hidden field (the builder picks the field name —
// id / ruleId / …; the test reads whichever hidden field carries the rule id).
function formCarriesId(form: El, id: string): boolean {
  for (const m of form.inner.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const a = m[1]!;
    if (attr(a, "type") === "hidden" && attr(a, "value") === id) return true;
  }
  return false;
}

// Whether `markup` carries a named form control (input / select / textarea) — used to
// prove the create form posts the task's NAMED payload fields.
function hasNamedControl(markup: string, name: string): boolean {
  return new RegExp(`<(?:input|select|textarea)\\b[^>]*\\bname="${name}"`, "i").test(markup);
}

const PAUSE_RE = /\bpause\b/i;
const DELETE_RE = /\b(delete|remove)\b/i;

// =====================================================================================
// AC1 — the loader reads ONLY the session user's rules (active AND paused), each read
// back as its exact plain sentence + status, plus the person's own agents. A user never
// sees another person's rules or agents.
// =====================================================================================

test("the loader returns the session person's rules (active and paused) with their sentences and statuses, and their agents", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const actions = makeActions(db, keyWrapper);

    // Alice's connected agent (offered as a "chosen agents" scope choice).
    await createAgent(
      db,
      { userId: alice.userId, connectionId: randomUUID(), displayName: "Claude", platform: "anthropic" },
      fixedClock(NOW),
    );
    // Bob's agent — must never appear in Alice's view.
    await createAgent(
      db,
      { userId: bob.userId, connectionId: randomUUID(), displayName: "BobBot", platform: "openai" },
      fixedClock(NOW),
    );

    // Alice gets two rules (one will be paused); Bob gets one.
    const aliceSession = await sessionFor(db, alice.userId);
    assert.equal((await actions.createRule(aliceSession, ASK_FIRST_EMAIL)).ok, true);
    assert.equal((await actions.createRule(aliceSession, NEVER_ALLOW_CHANGE)).ok, true);
    assert.equal(
      (await actions.createRule(await sessionFor(db, bob.userId), ASK_FIRST_EMAIL)).ok,
      true,
    );

    // Pause the never-allow rule, by its id discovered through a first load.
    const first = await actions.load(aliceSession);
    const toPause = first.rules.find((r) => r.sentence === NEVER_ALLOW_CHANGE_SENTENCE)!;
    assert.ok(toPause, "the never-allow rule is loaded before it is paused");
    assert.equal((await actions.pauseRule(aliceSession, toPause.id)).ok, true);

    const view = await actions.load(aliceSession);

    // Both of Alice's rules are present, each read back as its exact plain sentence…
    const bySentence = new Map(view.rules.map((r) => [r.sentence, r]));
    assert.ok(bySentence.has(ASK_FIRST_EMAIL_SENTENCE), "the active ask-first rule reads back verbatim");
    assert.ok(bySentence.has(NEVER_ALLOW_CHANGE_SENTENCE), "the paused never-allow rule reads back verbatim");
    // …with their lifecycle status (the paused one shown paused, not dropped).
    assert.equal(bySentence.get(ASK_FIRST_EMAIL_SENTENCE)!.status, "active", "the ask-first rule is active");
    assert.equal(bySentence.get(NEVER_ALLOW_CHANGE_SENTENCE)!.status, "paused", "the never-allow rule is paused");
    assert.equal(view.rules.length, 2, "exactly the session person's two rules are returned");

    // Alice's own agent is offered; Bob's never is.
    const agentNames = view.agents.map((a) => a.name);
    assert.ok(agentNames.includes("Claude"), "Alice's connected agent is offered as a scope choice");
    assert.ok(!agentNames.includes("BobBot"), "another person's agent is never offered");

    // Nothing of Bob's leaks into the serialised view.
    assert.ok(
      !JSON.stringify(view).includes("BobBot"),
      "no returned entry carries another person's agent",
    );
  } finally {
    await db.close();
  }
});

test("a person never sees another person's rules through the loader", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const actions = makeActions(db, keyWrapper);

    // Bob creates a rule with a distinctive recipient so it can be spotted anywhere.
    const BOB_ONLY = "bob-secret@example.com";
    assert.equal(
      (await actions.createRule(await sessionFor(db, bob.userId), {
        kind: "ask_first",
        scope: { type: "any_agent" },
        action: { type: "send_message", channel: "email" },
        condition: { type: "recipient_is", address: BOB_ONLY },
      })).ok,
      true,
    );
    // Alice has one rule of her own.
    assert.equal(
      (await actions.createRule(await sessionFor(db, alice.userId), ASK_FIRST_EMAIL)).ok,
      true,
    );

    const view = await actions.load(await sessionFor(db, alice.userId));

    assert.equal(view.rules.length, 1, "Alice sees exactly her own rule");
    assert.ok(
      !JSON.stringify(view).includes(BOB_ONLY),
      "Bob's rule (and its condition) never appears in Alice's loaded data",
    );
    // And it is never on Alice's rendered screen either.
    const markup = renderRules(view, {
      createAction: noopAction,
      updateAction: noopAction,
      pauseAction: noopAction,
      deleteAction: noopAction,
    });
    assert.ok(!markup.includes(BOB_ONLY), "Bob's rule is never on Alice's screen");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the loaded data mounts <RulesView> wired to the four server actions: the create
// form is bound to createRule and posts the NAMED payload fields; each rule's Delete is
// bound to deleteRule and carries its id; each active rule's Pause is bound to pauseRule
// and carries its id.
// =====================================================================================

test("the loaded rules mount a create form bound to createRule carrying the named payload fields", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);
    assert.equal((await actions.createRule(session, ASK_FIRST_EMAIL)).ok, true);

    const view = await actions.load(session);
    const markup = renderRules(view, {
      createAction: noopAction,
      updateAction: noopAction,
      pauseAction: noopAction,
      deleteAction: noopAction,
    });

    // The create form is the bound form that carries the template field (and no rule id —
    // it creates). It posts the task's named payload fields.
    const createForms = findAll(markup, "form").filter(
      (f) => isBoundToAction(f) && hasNamedControl(f.inner, "rule-template"),
    );
    assert.equal(createForms.length, 1, "a single create form is bound to the create server action");
    const createForm = createForms[0]!;
    for (const field of ["rule-template", "rule-action", "rule-channel", "rule-scope"]) {
      assert.ok(
        hasNamedControl(createForm.inner, field),
        `the create form posts a named "${field}" field; form=${createForm.inner}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("each loaded rule mounts a live Pause (active) and Delete bound to the server actions and carrying the rule id", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);
    assert.equal((await actions.createRule(session, ASK_FIRST_EMAIL)).ok, true);

    const view = await actions.load(session);
    const ruleId = view.rules[0]!.id;

    const markup = renderRules(view, {
      createAction: noopAction,
      updateAction: noopAction,
      pauseAction: noopAction,
      deleteAction: noopAction,
    });
    const forms = findAll(markup, "form");

    // Pause: a bound form carrying the rule id, labelled Pause (the rule is active).
    const pauseForms = forms.filter(
      (f) => isBoundToAction(f) && formCarriesId(f, ruleId) && PAUSE_RE.test(visibleText(f.inner)),
    );
    assert.equal(pauseForms.length, 1, "the active rule mounts a live Pause bound to pauseRule");
    assert.ok(formCarriesId(pauseForms[0]!, ruleId), "the Pause control carries the rule id it pauses");

    // Delete: a bound form carrying the rule id, labelled Delete/Remove.
    const deleteForms = forms.filter(
      (f) => isBoundToAction(f) && formCarriesId(f, ruleId) && DELETE_RE.test(visibleText(f.inner)),
    );
    assert.equal(deleteForms.length, 1, "the rule mounts a live Delete bound to deleteRule");
    assert.ok(formCarriesId(deleteForms[0]!, ruleId), "the Delete control carries the rule id it deletes");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Rules tidy-up — the loader hands the view each rule's KIND (shown as a word badge) and
// each agent's own workspace id (agents.id, distinct from the connection id a rule scope
// matches on), so Budgets can link that agent's real card-budget control. Agents come back
// in name order, so the scope choices and budget links never shuffle.
// =====================================================================================

test("the loader passes each rule's kind and each agent's workspace id, agents in name order", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);
    const zed = await createAgent(
      db,
      { userId: alice.userId, connectionId: randomUUID(), displayName: "Zed", platform: "openai" },
      fixedClock(NOW),
    );
    const claude = await createAgent(
      db,
      { userId: alice.userId, connectionId: randomUUID(), displayName: "Claude", platform: "anthropic" },
      fixedClock(NOW),
    );
    assert.equal((await actions.createRule(session, ASK_FIRST_EMAIL)).ok, true);
    assert.equal((await actions.createRule(session, NEVER_ALLOW_CHANGE)).ok, true);

    const view = await actions.load(session);
    const kinds = new Map(view.rules.map((r) => [r.sentence, r.kind]));
    assert.equal(kinds.get(ASK_FIRST_EMAIL_SENTENCE), "ask_first");
    assert.equal(kinds.get(NEVER_ALLOW_CHANGE_SENTENCE), "never_allow");

    assert.deepEqual(
      view.agents.map((a) => ({ id: a.id, name: a.name, workspaceId: a.workspaceId })),
      [
        { id: claude.connectionId, name: "Claude", workspaceId: claude.id },
        { id: zed.connectionId, name: "Zed", workspaceId: zed.id },
      ],
    );

    const markup = renderRules(view, { deleteAction: noopAction, pauseAction: noopAction, createAction: noopAction });
    assert.ok(markup.includes(`href="/agents/${claude.id}?section=spending"`), "Budgets links Claude's spending section");
    assert.ok(markup.includes(`href="/agents/${zed.id}?section=spending"`), "Budgets links Zed's spending section");
  } finally {
    await db.close();
  }
});
