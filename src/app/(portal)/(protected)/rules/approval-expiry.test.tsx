// The approval expiry setting on the Rules & budgets page (`./actions`, `./page.tsx`,
// `@/components/rules/rules-view`).
//
// Brief "Rules and approvals": rules include "an approval expiry time"; "approvals expire
// after the configured time (default 15 minutes, adjustable from 2 minutes to 24 hours) and
// an expired request is denied." The page shows the current value in a labelled select of
// presets; the save action re-derives the session (the page does), validates against the
// allowed range, saves under the SESSION user only, records the change in the person's
// activity record as an account change, and redirects with a plain-words notice.
//
// Behaviour only: the real stores over an isolated PGlite with the real migrations, and the
// view rendered with react-dom/server (no DOM). Every db handle is closed in a `finally`.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import {
  approvalExpiryInputFromForm,
  approvalExpiryNotice,
  createRulesActions,
  rulesNotice,
  rulesReturnHref,
} from "./actions";
import { RulesView } from "@/components/rules/rules-view";
import { createUser } from "@/server/db/users";
import { getApprovalExpiryMinutes, setApprovalExpiryMinutes } from "@/server/db/approval-settings";
import { saveNotificationPrefs } from "@/server/db/notification-prefs";
import { PORTAL_NAV, type NavNode } from "@/components/shell/nav";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { readActivity } from "@/server/activity/writer";
import { HttpError } from "@/server/http/validate";
import { activityCategory } from "@/domain/activity/category";
import { kindLabel } from "@/domain/activity/describe";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-15T12:00:00.000Z");

type Person = { userId: string; dek: Uint8Array; session: Session };

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string): Promise<Person> {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const { session } = await createSession(db, user.id, { clock: fixedClock(NOW), random: systemRandom });
  return { userId: user.id, dek, session };
}

function actionsFor(db: Db, keyWrapper: KeyWrapper) {
  return createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });
}

async function rejects4xx(fn: () => Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(fn, (error: unknown) => error instanceof HttpError && error.status >= 400 && error.status < 500, label);
}

// --- markup helpers (no DOM) ---------------------------------------------------------

function decode(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}
function expirySelect(markup: string): { attrs: string; options: { value: string; label: string; selected: boolean }[] } {
  const m = markup.match(/<select\b([^>]*\bname="approval-expiry-minutes"[^>]*)>([\s\S]*?)<\/select>/);
  assert.ok(m, "the page has a select named approval-expiry-minutes");
  const options = [...m[2]!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((o) => ({
    value: attr(o[1]!, "value") ?? "",
    label: visibleText(o[2]!),
    selected: /\bselected=""/.test(o[1]!),
  }));
  return { attrs: m[1]!, options };
}
function rulesTabPanel(markup: string): string {
  const starts = [...markup.matchAll(/<div role="tabpanel"([^>]*)>/g)];
  assert.ok(starts.length >= 2, "the page is organised into tab panels");
  return markup.slice(starts[0]!.index! + starts[0]![0].length, starts[1]!.index);
}
const noop = async (_formData: FormData): Promise<void> => {};

// --- loader + page render ------------------------------------------------------------

test("the page loads 15 minutes for a person who has set nothing, and the select shows it selected", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "expiry-page-default");
    const view = await actionsFor(db, keyWrapper).load(alice.session);
    assert.equal(view.approvalExpiryMinutes, 15);

    const markup = renderToStaticMarkup(
      <RulesView rules={view.rules} agents={view.agents} approvalExpiryMinutes={view.approvalExpiryMinutes} approvalExpiryAction={noop} />,
    );
    const select = expirySelect(markup);
    assert.deepEqual(
      select.options.map((o) => [o.value, o.label]),
      [
        ["2", "2 minutes"],
        ["5", "5 minutes"],
        ["10", "10 minutes"],
        ["15", "15 minutes (default)"],
        ["30", "30 minutes"],
        ["60", "1 hour"],
        ["120", "2 hours"],
        ["240", "4 hours"],
        ["480", "8 hours"],
        ["720", "12 hours"],
        ["1440", "24 hours"],
      ],
      "the presets run from 2 minutes to 24 hours, the default marked",
    );
    assert.deepEqual(select.options.filter((o) => o.selected).map((o) => o.value), ["15"], "the current value is selected");
  } finally {
    await db.close();
  }
});

test("the page shows the person's saved value selected, labelled, hinted and bound to the save action", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "expiry-page-saved");
    const bob = await makePerson(db, keyWrapper, "expiry-page-other");
    await setApprovalExpiryMinutes(db, { userId: alice.userId, minutes: 120, now: NOW });
    await setApprovalExpiryMinutes(db, { userId: bob.userId, minutes: 5, now: NOW });

    const view = await actionsFor(db, keyWrapper).load(alice.session);
    assert.equal(view.approvalExpiryMinutes, 120, "the loader reads the session person's own value");

    const markup = renderToStaticMarkup(
      <RulesView rules={view.rules} agents={view.agents} approvalExpiryMinutes={view.approvalExpiryMinutes} approvalExpiryAction={noop} />,
    );
    const select = expirySelect(markup);
    assert.deepEqual(select.options.filter((o) => o.selected).map((o) => o.value), ["120"]);

    // A real label for the control, and a hint read with it saying what expiry means.
    const id = attr(select.attrs, "id");
    assert.ok(id, "the select has an id its label points at");
    const label = markup.match(new RegExp(`<label[^>]*for="${id!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</label>`));
    assert.ok(label && visibleText(label[1]!).length > 0, "the select is labelled");
    const describedBy = (attr(select.attrs, "aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    assert.ok(describedBy.length > 0, "the select is described by its hint");
    const hint = markup.match(new RegExp(`<p[^>]*id="${describedBy[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</p>`));
    assert.ok(hint, "the hint is rendered");
    assert.match(visibleText(hint[1]!), /denied/i, "the hint says an expired request is denied");
    assert.match(visibleText(hint[1]!), /agent/i, "and that the agent is told");

    // It sits in the Your rules tab, inside a bounded panel, in a form bound to the action.
    const rulesTab = rulesTabPanel(markup);
    assert.match(rulesTab, /name="approval-expiry-minutes"/, "the setting is in the Your rules tab");
    const panel = rulesTab.match(/<section\b[^>]*class="wh-panel[^"]*"[^>]*>([\s\S]*?)<\/section>/g)?.find((s) => /approval-expiry-minutes/.test(s));
    assert.ok(panel, "the setting sits inside a panel");
    assert.match(visibleText(panel!), /Approval expiry/, "the panel is titled Approval expiry");
    const form = [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find((f) => /approval-expiry-minutes/.test(f[2]!));
    assert.ok(form && /^javascript:/.test(attr(form[1]!, "action") ?? ""), "the form is bound to the save server action");
    assert.ok(/<button\b[^>]*type="submit"/.test(form![2]!), "the form has a submit button");
  } finally {
    await db.close();
  }
});

test("a saved value that is not a preset is still shown as the current choice, never silently replaced", () => {
  const markup = renderToStaticMarkup(<RulesView rules={[]} agents={[]} approvalExpiryMinutes={45} />);
  const select = expirySelect(markup);
  const selected = select.options.filter((o) => o.selected);
  assert.deepEqual(selected.map((o) => [o.value, o.label]), [["45", "45 minutes"]]);
  const values = select.options.map((o) => Number(o.value));
  assert.deepEqual(values, [...values].sort((a, b) => a - b), "the options stay in time order");
});

// --- the save action -----------------------------------------------------------------

test("saving validates the range and the type: refused values write nothing", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "expiry-validate");
    const actions = actionsFor(db, keyWrapper);
    for (const input of [{ minutes: 1 }, { minutes: 1441 }, { minutes: 15.5 }, { minutes: "15" }, { minutes: Number.NaN }, {}, null, "15"]) {
      await rejects4xx(() => actions.setApprovalExpiry(alice.session, input), `refuses ${JSON.stringify(input)}`);
    }
    const rows = await db.query("SELECT count(*)::int AS n FROM approval_settings");
    assert.equal(rows.rows[0]!.n, 0, "nothing was written");
    assert.equal((await readActivity(db, alice.userId, alice.dek)).length, 0, "a refused save records nothing");
  } finally {
    await db.close();
  }
});

test("saving stores the value under the session person only, whatever id the input carries", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "expiry-owner");
    const bob = await makePerson(db, keyWrapper, "expiry-bystander");
    await setApprovalExpiryMinutes(db, { userId: bob.userId, minutes: 10, now: NOW });

    const result = await actionsFor(db, keyWrapper).setApprovalExpiry(alice.session, { minutes: 240, userId: bob.userId });
    assert.deepEqual(result, { ok: true });
    assert.equal(await getApprovalExpiryMinutes(db, alice.userId), 240, "the session person's setting is saved");
    assert.equal(await getApprovalExpiryMinutes(db, bob.userId), 10, "an id in the input never redirects the write");
    assert.equal((await readActivity(db, bob.userId, bob.dek)).length, 0, "nothing is recorded in another person's activity");
  } finally {
    await db.close();
  }
});

test("saving records the change in the person's activity as an account change by the owner", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "expiry-activity");
    const actions = actionsFor(db, keyWrapper);
    assert.deepEqual(await actions.setApprovalExpiry(alice.session, { minutes: 60 }), { ok: true });
    assert.deepEqual(await actions.setApprovalExpiry(alice.session, { minutes: 1440 }), { ok: true });

    const entries = await readActivity(db, alice.userId, alice.dek);
    assert.equal(entries.length, 2, "one entry per save");
    for (const entry of entries) {
      assert.equal(entry.kind, "approval_expiry_change");
      assert.equal(entry.source, "warthog", "Warthog writes the record");
      assert.equal(entry.agentId, undefined, "an owner's change is never attributed to an agent");
      assert.equal(entry.outcome, "saved");
      assert.equal(activityCategory({ kind: entry.kind, source: entry.source }, () => false), "account", "it is filed as an account change");
    }
    assert.deepEqual(entries.map((entry) => (entry.payload as { changes: unknown }).changes), [
      { before: { expiryMinutes: 15 }, after: { expiryMinutes: 60 } },
      { before: { expiryMinutes: 60 }, after: { expiryMinutes: 1440 } },
    ]);
    assert.equal((entries[0]!.payload as { actor: string }).actor, "account_owner");
    assert.equal(kindLabel("approval_expiry_change"), "Approval expiry change", "the kind reads in words");
  } finally {
    await db.close();
  }
});

// --- the form mapping and the notice ---------------------------------------------------

test("the form maps to whole minutes; anything else reaches validation as a non-number", () => {
  const form = (value?: string) => {
    const data = new FormData();
    if (value !== undefined) data.set("approval-expiry-minutes", value);
    return approvalExpiryInputFromForm(data);
  };
  assert.deepEqual(form("120"), { minutes: 120 });
  assert.deepEqual(form(" 30 "), { minutes: 30 });
  assert.ok(Number.isNaN(form("").minutes), "an empty field is not a number");
  assert.ok(Number.isNaN(form().minutes), "a missing field is not a number");
  assert.ok(Number.isNaN(form("15 minutes").minutes));
});

test("the save redirects back to the rules list with a plain-words notice", () => {
  assert.equal(approvalExpiryNotice({ ok: true }), "expiry_saved");
  assert.equal(approvalExpiryNotice(new HttpError(400, "bad")), "expiry_invalid");
  assert.equal(approvalExpiryNotice({ ok: false, reason: "invalid_expiry" }), "expiry_invalid");
  assert.equal(approvalExpiryNotice(new Error("db down")), "error");
  assert.equal(rulesReturnHref("expiry_saved", {}), "/rules?notice=expiry_saved");

  const saved = rulesNotice("expiry_saved");
  assert.equal(saved?.tone, "done");
  assert.match(saved!.text, /approval expiry/i);
  assert.match(saved!.text, /already waiting/i, "it says requests already waiting keep their time");
  const invalid = rulesNotice("expiry_invalid");
  assert.equal(invalid?.tone, "problem");
  assert.match(invalid!.text, /2 minutes/);
  assert.match(invalid!.text, /24 hours/);
});

// --- the reminder warning ----------------------------------------------------------------
//
// The text/email fallback (Settings › Notifications) fires after the person's fallback delay,
// and only while the approval has not expired. When the saved expiry is at or below that
// delay the reminder can never go out, so the panel says so — inside the panel — and links to
// where the delay is set. Notification timing itself is unchanged.

const NOTIFICATIONS_ROUTE = "/settings/notifications";

async function renderedFor(
  db: Db,
  keyWrapper: KeyWrapper,
  setup: { expiry?: number; delay?: number; emailFallback?: boolean; smsFallback?: boolean },
  who: string,
): Promise<string> {
  const person = await makePerson(db, keyWrapper, who);
  if (setup.expiry !== undefined) await setApprovalExpiryMinutes(db, { userId: person.userId, minutes: setup.expiry, now: NOW });
  if (setup.delay !== undefined || setup.emailFallback !== undefined || setup.smsFallback !== undefined) {
    const saved = await saveNotificationPrefs(db, {
      userId: person.userId,
      emailFallback: setup.emailFallback ?? true,
      smsFallback: setup.smsFallback ?? false,
      fallbackDelayMinutes: setup.delay ?? 2,
    });
    assert.equal(saved.ok, true);
  }
  const view = await actionsFor(db, keyWrapper).load(person.session);
  return renderToStaticMarkup(
    <RulesView
      rules={view.rules}
      agents={view.agents}
      approvalExpiryMinutes={view.approvalExpiryMinutes}
      approvalReminder={view.approvalReminder}
      approvalExpiryAction={noop}
    />,
  );
}

function expiryPanel(markup: string): string {
  const panel = rulesTabPanel(markup)
    .match(/<section\b[^>]*class="wh-panel[^"]*"[^>]*>([\s\S]*?)<\/section>/g)
    ?.find((s) => /approval-expiry-minutes/.test(s));
  assert.ok(panel, "the Approval expiry panel is rendered");
  return panel!;
}

function reminderWarning(panel: string): string | undefined {
  return [...panel.matchAll(/<div\b[^>]*data-tone="warning"[^>]*>([\s\S]*?)<\/div><\/div>/g)].map((m) => m[0])[0];
}

function navHrefs(nodes: readonly NavNode[]): string[] {
  return nodes.flatMap((node) => [...(node.href ? [node.href] : []), ...navHrefs(node.children ?? [])]);
}

test("the loader reads the session person's own reminder setting", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "reminder-owner");
    const bob = await makePerson(db, keyWrapper, "reminder-other");
    await saveNotificationPrefs(db, { userId: bob.userId, emailFallback: false, smsFallback: false, fallbackDelayMinutes: 30 });
    assert.deepEqual((await actionsFor(db, keyWrapper).load(alice.session)).approvalReminder, { on: true, delayMinutes: 2 }, "the defaults: email on, 2 minutes");

    await saveNotificationPrefs(db, { userId: alice.userId, emailFallback: false, smsFallback: true, fallbackDelayMinutes: 10 });
    assert.deepEqual((await actionsFor(db, keyWrapper).load(alice.session)).approvalReminder, { on: true, delayMinutes: 10 }, "a text reminder alone counts as on");
    assert.deepEqual((await actionsFor(db, keyWrapper).load(bob.session)).approvalReminder, { on: false, delayMinutes: 30 });
  } finally {
    await db.close();
  }
});

test("the warning shows inside the panel at an expiry of 2 minutes with a 2-minute reminder delay", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const markup = await renderedFor(db, keyWrapper, { expiry: 2, delay: 2 }, "warn-equal");
    const warning = reminderWarning(expiryPanel(markup));
    assert.ok(warning, "a warning notice sits inside the Approval expiry panel");
    const text = visibleText(warning!);
    assert.match(text, /reminder waits 2 minutes/i, "it names the reminder delay");
    assert.match(text, /won't be sent before requests expire/i, "and says the reminder can't go out in time");
    assert.match(text, /Choose a longer time, or shorten the reminder delay/i, "and what to do about it");

    // The select is described by the warning, so it is read with the control.
    const select = expirySelect(markup);
    const warningId = attr(warning!.match(/<p\b([^>]*)>/)![1]!, "id");
    assert.ok(warningId && (attr(select.attrs, "aria-describedby") ?? "").split(/\s+/).includes(warningId), "the select is described by the warning");
  } finally {
    await db.close();
  }
});

test("the warning also shows when the expiry is shorter than the reminder delay, by text alone", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const markup = await renderedFor(db, keyWrapper, { expiry: 5, delay: 10, emailFallback: false, smsFallback: true }, "warn-shorter");
    assert.match(visibleText(reminderWarning(expiryPanel(markup)) ?? ""), /reminder waits 10 minutes/i);
  } finally {
    await db.close();
  }
});

test("the warning is hidden at an expiry of 15 minutes with a 2-minute reminder delay", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const markup = await renderedFor(db, keyWrapper, { expiry: 15, delay: 2 }, "no-warn-longer");
    assert.equal(reminderWarning(expiryPanel(markup)), undefined, "no warning when the reminder goes out in time");
    assert.doesNotMatch(markup, /won't be sent before requests expire/i);
    const defaults = await renderedFor(db, keyWrapper, {}, "no-warn-defaults");
    assert.equal(reminderWarning(expiryPanel(defaults)), undefined, "nor with the defaults (15 minutes, 2-minute delay)");
  } finally {
    await db.close();
  }
});

test("the warning is hidden when text and email reminders are both off", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const markup = await renderedFor(db, keyWrapper, { expiry: 2, delay: 2, emailFallback: false, smsFallback: false }, "no-warn-off");
    assert.equal(reminderWarning(expiryPanel(markup)), undefined, "no reminder is due, so nothing to warn about");
  } finally {
    await db.close();
  }
});

test("the warning links to the real Notifications settings route with a full-size target", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const warning = reminderWarning(expiryPanel(await renderedFor(db, keyWrapper, { expiry: 2, delay: 2 }, "warn-link")));
    const links = [...warning!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    assert.equal(links.length, 1, "one link in the warning");
    assert.equal(attr(links[0]![1]!, "href"), NOTIFICATIONS_ROUTE, "it opens Settings › Notifications");
    assert.ok(navHrefs(PORTAL_NAV).includes(NOTIFICATIONS_ROUTE), "that is the route the navigation uses for Notifications");
    assert.match(attr(links[0]![1]!, "class") ?? "", /\bmin-h-11\b/, "a 44px touch target");
    assert.ok(visibleText(links[0]![2]!).length > 0, "the link says where it goes");
  } finally {
    await db.close();
  }
});

test("the select hint says reminders go out after the delay set in Settings", () => {
  const markup = renderToStaticMarkup(<RulesView rules={[]} agents={[]} approvalExpiryMinutes={15} />);
  const select = expirySelect(markup);
  const hintId = (attr(select.attrs, "aria-describedby") ?? "").split(/\s+/).find((id) => id.endsWith("-hint"));
  assert.ok(hintId, "the select has a hint");
  const hint = markup.match(new RegExp(`<p[^>]*id="${hintId!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</p>`));
  assert.ok(hint, "the hint is rendered");
  assert.match(visibleText(hint![1]!), /reminders go out after the delay set in Settings/i);
});
