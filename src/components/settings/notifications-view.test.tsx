// E12-S18 — Notification settings view component
// (src/components/settings/notifications-view.tsx).
//
// RED-first: src/components/settings/notifications-view.tsx does NOT exist yet, so
// importing `./notifications-view` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do NOT
// implement anything to make these pass.
//
// WHY this component exists (brief "Notification settings"; design §10 Notifications):
// the notification settings screen is where a person sets up HOW they are reached.
// It must let them:
//   - register one or more devices for push notifications,
//   - add and verify a mobile number for the SMS fallback with a 6-digit code,
//   - choose whether fallback messages also go by email (ON by default),
//   - send a test notification, and
//   - choose the fallback delay (default 2 minutes, adjustable 1–30 minutes).
// Because "no dead controls" is the law, the test-notification control is DISABLED
// with a STATED REASON when there is no registered device to push to — never a live
// button that does nothing.
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The
// real plumbing — actually registering a push subscription, sending the verification
// SMS, persisting the preferences, firing the test push — lives in the server
// composition root and a sibling actions module wired by a LATER task. THIS component
// renders the screen from its props so it can be pinned without a browser, a session
// or any server plumbing: the registered devices, the person's mobile numbers (each
// with its verified flag), and the two saved preferences (email fallback + delay)
// drive the initial render. An UNVERIFIED number drives the code-entry + verify UI;
// a VERIFIED number shows its verified state — exactly the precedent the sibling
// consent/rules views set (a prop selects the initial state of a conceptually-
// interactive screen), so a render test pins each state without clicking anything.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given
// (the controls a person can actually use, their live/disabled state, the
// verified/unverified wording, the delay bounds and defaults) — never the source text
// of notifications-view.tsx. A later behaviour-preserving refactor (different wrapper
// elements, reworded-but-still-plain copy, a <select> vs radios, extra classes, a
// different icon) stays green. We render with `react-dom/server` (no DOM/jsdom — React
// component / E2E testing is a per-job ADR) and read the emitted markup, exactly as
// the sibling component tests do.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms):
//
//   NotificationsView({ devices, numbers, emailFallback?, fallbackDelayMinutes? }):
//     • devices  — the person's registered push devices (StoredPushSubscription-
//                  shaped): { id, label? }. When EMPTY, the "send a test notification"
//                  control is disabled with a stated reason (nothing to push to).
//     • numbers  — the person's mobile numbers (StoredMobileNumber-shaped):
//                  { id, number, verified }. A VERIFIED number shows its verified
//                  state in words; an UNVERIFIED number shows its not-verified state
//                  and offers a 6-digit code field + a live Verify control.
//     • emailFallback          — whether fallback messages also go by email.
//                                OPTIONAL; the view defaults it ON (brief default).
//     • fallbackDelayMinutes   — the fallback delay in minutes. OPTIONAL; the view
//                                defaults it to 2 (brief default). The control is
//                                bounded to the inclusive 1–30 range.
//
// Behaviours asserted below:
//   - a live control to register a push device.
//   - a live field to add a mobile number + a live control to request its code.
//   - an UNVERIFIED number renders a live 6-digit code field + a live Verify control,
//     and shows its not-verified state in words.
//   - a VERIFIED number shows its verified state in words.
//   - a live email-fallback toggle, ON by default (and reflecting the prop).
//   - a fallback-delay field bounded 1–30, defaulting to 2 (and reflecting the prop).
//   - the "send a test notification" control is LIVE when a device is registered, and
//     DISABLED WITH A STATED REASON (about a device) when none is — no dead control.
//   - no raw hex colour anywhere.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { NotificationsView } from "./notifications-view";

test("SMS-off settings show availability without enrolment or opt-in controls", () => {
  const html = renderToStaticMarkup(<NotificationsView devices={[{ id: "device" }]}
    numbers={[{ id: "mobile", number: "+61412345678", verified: false }]} smsEnabled={false} smsFallback={true} smsCountries={["AU"]} />);
  assert.match(html, /Text message alerts aren(&#x27;|')t available yet/);
  for (const name of ["number", "code", "smsFallback"]) assert.ok(!html.includes(`name="${name}"`));
  assert.ok(!html.includes("+61412345678") && !html.includes("Send code"));
  assert.match(html, /name="emailFallback"/);
  assert.match(html, /Register this device/);
  assert.match(html, /Send a test notification/);
});

// content-30 — with no SMS destination enabled, every text would be refused, so the page
// shows one plain line instead of the number form, the SMS switch and their legal text —
// and a saved SMS-alert choice is carried through unchanged rather than silently cleared.
test("with no SMS destination enabled, the number form, SMS switch and SMS terms are replaced by one line", () => {
  const html = renderToStaticMarkup(<NotificationsView devices={[{ id: "device" }]}
    numbers={[{ id: "mobile", number: "+61412345678", verified: true }]} smsFallback={true} smsCountries={[]} />);
  assert.match(html, /Text message alerts aren(&#x27;|')t available yet/);
  assert.ok(!html.includes('name="number"') && !html.includes("Send code") && !html.includes("+61412345678"));
  assert.ok(!/type="checkbox"[^>]*name="smsFallback"/.test(html), "no SMS switch is offered");
  assert.ok(!/Reply STOP/.test(html), "no SMS terms for a channel that can't be used");
  assert.match(html, /<input type="hidden" name="smsFallback" value="on"\/>/, "a saved SMS-alert choice is kept");
  assert.match(html, /name="emailFallback"/);
  const off = renderToStaticMarkup(<NotificationsView devices={[]} numbers={[]} smsCountries={[]} />);
  assert.ok(!off.includes('name="smsFallback"'), "nothing to keep when SMS alerts were never on");
});

// --- the prop shape this task introduces (described here as the contract) -------

type NotificationsViewDevice = { id: string; label?: string };
type NotificationsViewNumber = { id: string; number: string; verified: boolean };

type NotificationsViewProps = {
  devices: ReadonlyArray<NotificationsViewDevice>;
  numbers: ReadonlyArray<NotificationsViewNumber>;
  emailFallback?: boolean;
  fallbackDelayMinutes?: number;
  smsCountries?: readonly string[];
};

// --- fixtures -------------------------------------------------------------------
//
// The two numbers carry distinct, recognisable digit strings so every "shows this
// number" / "shows this number's state" assertion is honest: the state word is read
// from a render that contains ONLY the number under test, so it can only describe
// that number.

const DEVICE: NotificationsViewDevice = { id: "d-phone", label: "This phone" };

const VERIFIED_NUMBER: NotificationsViewNumber = {
  id: "n-verified",
  number: "+61400111222",
  verified: true,
};
const UNVERIFIED_NUMBER: NotificationsViewNumber = {
  id: "n-unverified",
  number: "+61400333444",
  verified: false,
};

function base(overrides: Partial<NotificationsViewProps> = {}): NotificationsViewProps {
  return {
    devices: [DEVICE],
    numbers: [VERIFIED_NUMBER, UNVERIFIED_NUMBER],
    // one enabled SMS destination, so the number controls are offered (content-30)
    smsCountries: ["AU"],
    // emailFallback + fallbackDelayMinutes intentionally omitted → the view's own
    // defaults (on / 2 minutes), which several tests pin.
    ...overrides,
  };
}

// --- markup helpers (no DOM), mirrored from the sibling component tests ---------

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

// Visible text of an HTML fragment: the words a sighted reader sees (an <svg> icon
// contributes none, and an attribute value like an input's `value` is NOT visible
// text — the tag is stripped whole), tags stripped and entities decoded.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

// A boolean/valueless attribute present as its own token — ` disabled`, ` disabled=""`
// or ` disabled="disabled"` — but never the word inside another attribute.
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}

function findAll(markup: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// id → the visible text of the <label for=id> that targets it.
function labelTextById(markup: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}

// Names of every actionable (not-disabled) control: a live <button>, a non-disabled
// checkbox/radio input (by label / aria-label / value), a wrapping-label input, or an
// <option>. Reads RENDERED, LIVE affordances — never dead static text — covering the
// common control shapes without pinning any one implementation.
function selectableNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (hasBoolAttr(b.attrs, "disabled")) continue;
    out.push((visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim());
  }
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    if (hasBoolAttr(attrs, "disabled")) continue;
    const id = attr(attrs, "id");
    out.push(((id && labels[id]) || attr(attrs, "aria-label") || attr(attrs, "value") || "").trim());
  }
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im || hasBoolAttr(im[1], "disabled")) continue;
    out.push(visibleText(l.inner));
  }
  for (const o of findAll(markup, "option")) out.push(visibleText(o.inner));
  return out.filter((n) => n.length > 0);
}

function hasSelectable(markup: string, re: RegExp): boolean {
  return selectableNames(markup).some((n) => re.test(n));
}

// Every <button> with its accessible name and disabled state (live OR disabled).
function allButtons(markup: string): Array<{ name: string; disabled: boolean }> {
  return findAll(markup, "button").map((b) => ({
    name: (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim(),
    disabled: hasBoolAttr(b.attrs, "disabled"),
  }));
}

function button(markup: string, re: RegExp): { name: string; disabled: boolean } | undefined {
  return allButtons(markup).find((b) => re.test(b.name));
}

// Toggle-like controls — a checkbox/radio input (named by its <label for>, wrapping
// <label> or aria-label) OR a role=switch / aria-checked / aria-pressed element —
// with its accessible name, on-state and disabled flag. Reads RENDERED ACCESSIBLE
// STATE (behaviour), covering the common accessible toggle implementations.
type Toggle = { name: string; on: boolean; disabled: boolean };
function toggleControls(markup: string): Toggle[] {
  const labels = labelTextById(markup);
  const out: Toggle[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    const id = attr(attrs, "id");
    const name = ((id && labels[id]) || attr(attrs, "aria-label") || "").trim();
    out.push({
      name,
      on: hasBoolAttr(attrs, "checked") || attr(attrs, "aria-checked") === "true",
      disabled: hasBoolAttr(attrs, "disabled"),
    });
  }
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im) continue;
    const iattrs = im[1];
    const type = (attr(iattrs, "type") ?? "text").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    out.push({
      name: visibleText(l.inner),
      on: hasBoolAttr(iattrs, "checked") || attr(iattrs, "aria-checked") === "true",
      disabled: hasBoolAttr(iattrs, "disabled"),
    });
  }
  for (const b of findAll(markup, "button")) {
    const role = attr(b.attrs, "role");
    const ariaChecked = attr(b.attrs, "aria-checked");
    const ariaPressed = attr(b.attrs, "aria-pressed");
    if (role !== "switch" && ariaChecked == null && ariaPressed == null) continue;
    out.push({
      name: (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim(),
      on: ariaChecked === "true" || ariaPressed === "true",
      disabled: hasBoolAttr(b.attrs, "disabled"),
    });
  }
  return out;
}

function toggle(markup: string, re: RegExp): Toggle | undefined {
  return toggleControls(markup).find((c) => re.test(c.name));
}

// Value-bearing inputs (text / number / tel / … — anything that is not a checkbox,
// radio or other non-value control) with their accessible label and the attributes a
// bounded/typed field carries. `defaultValue` renders as the `value` attribute and
// `maxLength` as `maxlength` in SSR markup.
type ValueInput = {
  label: string;
  value: string | null;
  placeholder: string | null;
  disabled: boolean;
  min: string | null;
  max: string | null;
  maxlength: string | null;
  type: string;
};
function valueInputs(markup: string): ValueInput[] {
  const NON_VALUE = new Set(["checkbox", "radio", "hidden", "submit", "button", "reset", "image", "file"]);
  const labels = labelTextById(markup);
  const out: ValueInput[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (NON_VALUE.has(type)) continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      value: attr(attrs, "value"),
      placeholder: attr(attrs, "placeholder"),
      disabled: hasBoolAttr(attrs, "disabled"),
      min: attr(attrs, "min"),
      max: attr(attrs, "max"),
      maxlength: attr(attrs, "maxlength"),
      type,
    });
  }
  return out;
}

function valueField(markup: string, re: RegExp): ValueInput | undefined {
  return valueInputs(markup).find((i) => re.test(i.label));
}

// Does `re` appear in the visible text within `window` chars either side of the first
// occurrence of `needle`? Proves two things are rendered TOGETHER (a disabled control
// and its stated reason) without pinning exact layout.
function nearInText(markup: string, needle: string, re: RegExp, window = 220): boolean {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  const lo = Math.max(0, i - window);
  const hi = Math.min(vt.length, i + needle.length + window);
  return re.test(vt.slice(lo, hi));
}

function render(props: NotificationsViewProps): string {
  return renderToStaticMarkup(<NotificationsView {...props} />);
}

// --- recognisers for the five control groups (the contract's own vocabulary) ----

const REGISTER_RE = /register|enable (push|notif)|turn on (push|notif)|add (a |your )?device/i;
const SEND_CODE_RE = /send (a |me )?(the )?code|text me|get (a |the )?code|add (a |your )?(mobile|number|phone)/i;
const VERIFY_RE = /verify/i;
const TEST_RE = /test/i;

// ================================================================================
// AC1 — renders a control to register a push device.
// ================================================================================

test("renders a live control to register a push device", () => {
  const markup = render(base());
  assert.ok(
    hasSelectable(markup, REGISTER_RE),
    `the screen must offer a live control to register a push device; controls=${JSON.stringify(
      selectableNames(markup),
    )}`,
  );
});

// ================================================================================
// AC1 — renders controls to add and verify a mobile number with a 6-digit code.
// ================================================================================

test("renders a live field to add a mobile number", () => {
  const markup = render(base({ numbers: [] }));
  const field = valueField(markup, /mobile|phone|number/i);
  assert.ok(field, `the screen must offer a field to enter a mobile number; fields=${JSON.stringify(valueInputs(markup))}`);
  assert.ok(field && !field.disabled, "the mobile-number field must be live (editable), not disabled");
});

test("renders a live control to request the verification code", () => {
  const markup = render(base({ numbers: [] }));
  assert.ok(
    hasSelectable(markup, SEND_CODE_RE),
    `the screen must offer a live control to send/request the verification code; controls=${JSON.stringify(
      selectableNames(markup),
    )}`,
  );
});

test("an unverified number offers a live 6-digit code field and a live Verify control", () => {
  const markup = render(base({ numbers: [UNVERIFIED_NUMBER] }));

  const code = valueField(markup, /code/i);
  assert.ok(code, `an unverified number must offer a code-entry field; fields=${JSON.stringify(valueInputs(markup))}`);
  assert.ok(code && !code.disabled, "the code field must be live (editable), not disabled");

  // The code is 6 digits — communicated by the field (maxlength 6) or in words.
  const sixDigits =
    (code && code.maxlength === "6") || /6[\s-]?digit|six[\s-]?digit/i.test(visibleText(markup));
  assert.ok(
    sixDigits,
    `the code field must communicate a 6-digit code (maxlength 6 or "6-digit" in words); code=${JSON.stringify(code)}, text="${visibleText(markup)}"`,
  );

  assert.ok(
    hasSelectable(markup, VERIFY_RE),
    `an unverified number must offer a live Verify control; controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

// ================================================================================
// AC2 — shows the verified / unverified state of the number (in words).
// ================================================================================

test("shows a verified number's number and its verified state in words", () => {
  // Only a verified number is present, so the sole status word describes it; a
  // not-verified wording must NOT appear (the design rule: words + icon, not colour
  // alone, and the two states must be distinguishable).
  const text = visibleText(render(base({ numbers: [VERIFIED_NUMBER] })));
  assert.ok(
    text.includes(VERIFIED_NUMBER.number),
    `the screen must show the number it is describing; text="${text}"`,
  );
  assert.match(
    text,
    /\bverified\b/i,
    `a verified number must show its verified state in words; text="${text}"`,
  );
  assert.ok(
    !/unverified|not verified|not yet verified|pending|awaiting/i.test(text),
    `a verified number must NOT be shown as not-verified; text="${text}"`,
  );
});

test("shows an unverified number's not-verified state in words", () => {
  const text = visibleText(render(base({ numbers: [UNVERIFIED_NUMBER] })));
  assert.ok(
    text.includes(UNVERIFIED_NUMBER.number),
    `the screen must show the number it is describing; text="${text}"`,
  );
  assert.match(
    text,
    /unverified|not verified|not yet verified|pending|awaiting|verify/i,
    `an unverified number must show its not-verified state in words; text="${text}"`,
  );
});

// ================================================================================
// AC1 — toggle email fallback (on by default).
// ================================================================================

test("renders a live email-fallback toggle", () => {
  const markup = render(base());
  const email = toggle(markup, /email/i);
  assert.ok(email, `the screen must offer an email-fallback toggle; toggles=${JSON.stringify(toggleControls(markup))}`);
  assert.ok(email && !email.disabled, "the email-fallback toggle must be live, not disabled");
});

test("defaults the email-fallback toggle ON when no preference is given", () => {
  const email = toggle(render(base()), /email/i);
  assert.ok(email && email.on, "with no saved preference, the email-fallback toggle must default ON (brief default)");
});

test("reflects a saved email-fallback preference of OFF", () => {
  const email = toggle(render(base({ emailFallback: false })), /email/i);
  assert.ok(email && !email.on, "an email-fallback preference of false must render the toggle OFF");
});

// ================================================================================
// AC1 — set the fallback delay between 1 and 30 minutes (default 2).
// ================================================================================

test("renders a fallback-delay field bounded to the inclusive 1–30 range", () => {
  const field = valueField(render(base()), /delay|minute|wait/i);
  assert.ok(field, "the screen must offer a fallback-delay field");
  assert.equal(field?.min, "1", `the fallback-delay field must have a minimum of 1 minute; field=${JSON.stringify(field)}`);
  assert.equal(field?.max, "30", `the fallback-delay field must have a maximum of 30 minutes; field=${JSON.stringify(field)}`);
  assert.ok(field && !field.disabled, "the fallback-delay field must be live (adjustable), not disabled");
});

test("defaults the fallback delay to 2 minutes when no preference is given", () => {
  const field = valueField(render(base()), /delay|minute|wait/i);
  assert.equal(field?.value, "2", `with no saved preference, the fallback delay must default to 2 minutes; field=${JSON.stringify(field)}`);
});

test("reflects a saved fallback delay", () => {
  // 15 is neither the default (2) nor a bound (1/30), so its presence as the field's
  // value can only be the view reflecting the saved preference.
  const field = valueField(render(base({ fallbackDelayMinutes: 15 })), /delay|minute|wait/i);
  assert.equal(field?.value, "15", `the fallback-delay field must reflect the saved value; field=${JSON.stringify(field)}`);
});

// ================================================================================
// AC1 + AC2 — send a test notification: live with a device, disabled WITH A REASON
// without one (no dead controls).
// ================================================================================

test("the test-notification control is LIVE when a device is registered", () => {
  const markup = render(base({ devices: [DEVICE] }));
  const testBtn = button(markup, TEST_RE);
  assert.ok(testBtn, `the screen must offer a "send a test notification" control; buttons=${JSON.stringify(allButtons(markup))}`);
  assert.ok(testBtn && !testBtn.disabled, "with a device registered, the test-notification control must be live (not disabled)");
});

test("the test-notification control is DISABLED with a stated reason when no device is registered", () => {
  const markup = render(base({ devices: [] }));
  const testBtn = button(markup, TEST_RE);
  assert.ok(testBtn, `the screen must still render the "send a test notification" control; buttons=${JSON.stringify(allButtons(markup))}`);
  assert.ok(
    testBtn && testBtn.disabled,
    "with no device registered, the test-notification control must be DISABLED (not a dead live button)",
  );
  // No dead controls: the disabled test control must be accompanied by a reason that
  // references needing/registering a device.
  assert.ok(
    nearInText(markup, "test", /\bdevice\b/i),
    `the disabled test control must state a reason mentioning a device; text="${visibleText(markup)}"`,
  );
  assert.ok(
    nearInText(markup, "test", /register|add|need|no |first|before|once/i),
    `the disabled test control's reason must say what to do (register/add a device); text="${visibleText(markup)}"`,
  );
});

// ================================================================================
// Design system — colour comes from tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour", () => {
  const variants: NotificationsViewProps[] = [
    base(),
    base({ devices: [] }),
    base({ numbers: [] }),
    base({ numbers: [UNVERIFIED_NUMBER] }),
    base({ numbers: [VERIFIED_NUMBER], emailFallback: false, fallbackDelayMinutes: 30 }),
  ];
  for (const props of variants) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the notifications-view markup, got: ${markup}`,
    );
  }
});

// ================================================================================
// Review fix G5 — devices are told apart and each can be removed.
// ================================================================================

test("each registered device shows its own label (never every row as 'This device') and a live Remove", () => {
  const markup = render(
    base({
      devices: [
        { id: "11111111-1111-4111-8111-111111111111", label: "Registered 1 Nov 2026, 9:00 am", fingerprint: "a".repeat(64) },
        { id: "22222222-2222-4222-8222-222222222222", label: "Registered 5 Nov 2026, 6:30 pm", fingerprint: "b".repeat(64) },
      ],
      removePushDeviceAction: async () => {},
    }),
  );
  const text = visibleText(markup);
  assert.ok(text.includes("Registered 1 Nov 2026, 9:00 am") && text.includes("Registered 5 Nov 2026, 6:30 pm"));
  assert.ok(!/This device/.test(text), "no row is claimed as this device before the browser has checked");
  const removeForms = findAll(markup, "form").filter((f) => /Remove/.test(visibleText(f.inner)));
  assert.equal(removeForms.length, 2, "one Remove form per device");
  assert.match(removeForms[0]!.inner, /<input[^>]*type="hidden"[^>]*name="id"[^>]*value="11111111-1111-4111-8111-111111111111"/);
  assert.match(removeForms[0]!.inner, /aria-label="Remove Registered 1 Nov 2026, 9:00 am"/);
});

// Review fix W4.1 — the install prompt is offered here too (iOS only delivers web push to
// an app added to the Home Screen), with its own notification part hidden because this
// screen's "Register this device" already sets notifications up.
test("W4.1: the screen mounts the install prompt without a second notifications control", () => {
  const markup = render({ devices: [], numbers: [] });
  assert.match(markup, /data-install-prompt/, "the install prompt is mounted");
  const section = markup.slice(markup.indexOf("data-install-prompt"));
  assert.doesNotMatch(section.slice(0, section.indexOf("</div>")), /Turn on notifications/i);
});
