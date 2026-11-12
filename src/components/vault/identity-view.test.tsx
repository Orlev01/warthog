// E11-S13 — Vault identity view component (src/components/vault/identity-view.tsx).
//
// RED-first: src/components/vault/identity-view.tsx does NOT exist yet, so importing
// `./identity-view` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement
// anything to make these pass.
//
// WHY this component exists (brief "Identity vault"; design §4.1 low tier + §4.2
// device-held vault; primary journey "About you"): the identity page is the
// primary-journey "About you" surface. It renders every tier from props and must:
//   - show LOW-tier fields (name, preferred name, email, phone, postal address with
//     a "moving on" date, language, time zone, preferences) as EDITABLE in place;
//   - list HIGH-tier fields (date of birth, passport, driver licence, car
//     registration, custom) LOCKED — each with its label and tier — and NEVER show a
//     high-tier value (the view is only ever handed high-tier METADATA, never a
//     value or its ciphertext — E11-S12 loadVaultPageData);
//   - offer an "Add a high-tier detail" control that, at that sensitive moment, shows
//     the plain explainer of HOW the detail is protected and WHO can ever read it,
//     and seals the entered value with the vault key ON THE DEVICE so only ciphertext
//     ever leaves (design §4.2 — the server stores ciphertext only, holds no key);
//   - offer a "Raise to high tier" control per low-tier field that RE-SEALS that
//     field's value on the device.
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The
// real plumbing — holding the unlocked vault key, POSTing the sealed submission, the
// server action that stores it — is wired by E11-S20's live <HighTierFlow/>, which this
// view now mounts for BOTH the "Add a high-tier detail" panel AND each low-tier field's
// "Raise to high tier" control (its device behaviour — create/unlock the vault key →
// seal the value → submit only ciphertext + metadata to the page's saveHighTierField /
// raiseFieldToHighTier actions — is pinned by high-tier-flow.test.tsx, not here). This
// file keeps pinning what IdentityView RENDERS. Like the sibling rules / consent /
// notifications views, a PROP selects the initial state of the conceptually-interactive
// "add a high-tier detail" panel, so a render test pins each state without clicking
// anything (no DOM; React component / E2E testing is a per-job ADR). We render with
// `react-dom/server` and read the emitted markup, exactly as the sibling component tests
// do.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given,
// and what the exported device-seal step RETURNS when called — never the source text
// of identity-view.tsx. A later behaviour-preserving refactor (different wrapper
// elements, reworded-but-still-plain copy, extra classes, a different icon) stays
// green. The one non-render-testable obligation — "the value is sealed with the vault
// key on the device before it is sent (only ciphertext leaves)" — is pinned by
// calling the exported pure seal step directly and checking what it returns, which is
// behaviour (call a function, check its output), not source text.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms):
//
//   IdentityView({ lowTierFields, highTierFields, addingHighTier?,
//                  saveHighTierField?, raiseFieldToHighTier? }):
//     • lowTierFields   — the owner's low-tier fields, values DECRYPTED (exactly
//                         VaultPageData.lowTierFields): { id, userId, kind, value,
//                         movingOn }. Rendered EDITABLE in place; a postal_address
//                         carries its moving-on date. Each gets a "Raise to high
//                         tier" control.
//     • highTierFields  — the owner's high-tier fields, METADATA ONLY (exactly
//                         VaultPageData.highTierFields): { id, userId, type, label,
//                         tier: "high" } — no value, no ciphertext. Rendered LOCKED,
//                         each with its label and tier; never editable.
//     • addingHighTier? — selects the initial state of the "add a high-tier detail"
//                         panel (the rules-view `draft` idiom). When true the panel
//                         is OPEN: it shows the sensitive-moment explainer (how it is
//                         protected + who can read it), a live value-entry field, and
//                         a live confirm/add control. Defaults to CLOSED.
//     • saveHighTierField? / raiseFieldToHighTier? — E11-S20 supersession: the add and
//                         raise controls are now LIVE on-device flows (<HighTierFlow/>),
//                         so the view passes each flow its submit seam — the page's
//                         saveHighTierField / raiseFieldToHighTier server actions that
//                         store the device-sealed submission. Rendered here with no-ops
//                         so the controls are live; the device flow's own behaviour
//                         (create/unlock the vault key → seal → submit) is pinned by
//                         high-tier-flow.test.tsx, not here.
//
//   sealHighTierDetail(vaultKey, detail): Promise<submission>
//     • The device-seal step the Add-high-tier and Raise-to-high-tier controls run
//       before anything leaves the device: it seals `detail.value` under the
//       in-memory vault key and returns the submission the server stores — carrying
//       ONLY the sealed ciphertext (a `v1:` envelope that round-trips under the SAME
//       vault key via decryptValue) and the plaintext metadata (type, label), NEVER
//       the plaintext value.
//     • vaultKey — the raw 256-bit vault key bytes (as createVaultKey yields);
//       detail — { type, label, value }.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { IdentityView, sealHighTierDetail } from "./identity-view";
import { sectionNavigation } from "@/components/shell/workspace-navigation";
import { decryptValue } from "@/client/vault/values";

// --- the prop shapes this task renders (described here as the contract; declared
// locally so the component test never couples to the server db modules) -----------

type LowTierField = {
  id: string;
  userId: string;
  kind:
    | "name"
    | "preferred_name"
    | "email"
    | "phone"
    | "postal_address"
    | "language"
    | "time_zone"
    | "preference";
  value: string;
  movingOn: string | null;
};

type HighTierField = {
  id: string;
  userId: string;
  type: "date_of_birth" | "passport" | "driver_licence" | "car_registration" | "custom";
  label: string;
  tier: "high";
};

type IdentityViewProps = {
  lowTierFields: ReadonlyArray<LowTierField>;
  highTierFields: ReadonlyArray<HighTierField>;
  addingHighTier?: boolean;
  // E11-S20 supersession: the add and raise controls are now LIVE on-device flows
  // (HighTierFlow), so the open panels need their submit seams — the page's
  // saveHighTierField / raiseFieldToHighTier server actions that store the sealed
  // submission. Rendered here with no-ops so the controls are live; the device flow's own
  // behaviour (create/unlock the vault key → seal → submit) is pinned by
  // high-tier-flow.test.tsx, not here.
  saveHighTierField?: (submission: unknown) => Promise<{ ok: boolean }>;
  raiseFieldToHighTier?: (submission: unknown) => Promise<{ ok: boolean }>;
};

// --- fixtures ---------------------------------------------------------------------
//
// Distinctive, recognisable values so every "renders this value" / "never leaks this
// value" assertion is honest — the string can only be the field under test.

const OWNER = "user-abc";

const NAME: LowTierField = { id: "lf-name", userId: OWNER, kind: "name", value: "Ada Banks", movingOn: null };
const EMAIL: LowTierField = {
  id: "lf-email",
  userId: OWNER,
  kind: "email",
  value: "ada@banksia.example",
  movingOn: null,
};
const PHONE: LowTierField = {
  id: "lf-phone",
  userId: OWNER,
  kind: "phone",
  value: "+61400778899",
  movingOn: null,
};
// A postal address that carries a "moving on" date (a distinctive ISO date that is
// neither today nor any other fixture value).
const ADDRESS_MOVING: LowTierField = {
  id: "lf-addr",
  userId: OWNER,
  kind: "postal_address",
  value: "12 Banksia Street, Perth",
  movingOn: "2027-09-15",
};

const PASSPORT: HighTierField = {
  id: "hf-passport",
  userId: OWNER,
  type: "passport",
  label: "Passport",
  tier: "high",
};
const DOB: HighTierField = {
  id: "hf-dob",
  userId: OWNER,
  type: "date_of_birth",
  label: "Date of birth",
  tier: "high",
};

// The submit seams the now-live add / raise panels need (E11-S20). No-ops here — these
// tests only render; the device flow is never submitted. Its behaviour lives in
// high-tier-flow.test.tsx.
const noopSaveHighTierField = async () => ({ ok: true as const });
const noopRaiseFieldToHighTier = async () => ({ ok: true as const });

function base(overrides: Partial<IdentityViewProps> = {}): IdentityViewProps {
  return {
    lowTierFields: [NAME, EMAIL, PHONE],
    highTierFields: [PASSPORT, DOB],
    saveHighTierField: noopSaveHighTierField,
    raiseFieldToHighTier: noopRaiseFieldToHighTier,
    ...overrides,
  };
}

function render(props: IdentityViewProps): string {
  return renderToStaticMarkup(<IdentityView {...props} />);
}

// --- markup helpers (no DOM), mirrored from the sibling component tests -----------

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
// contributes none; an attribute value like an input's `value` is NOT visible text —
// the tag is stripped whole), tags stripped and entities decoded.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

// A boolean/valueless attribute present as its own token — ` disabled`, ` disabled=""`
// or ` disabled="disabled"` — but never the word inside another attribute's value.
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

// Every <button> with its accessible name and disabled state (live OR disabled).
function allButtons(markup: string): Array<{ name: string; disabled: boolean }> {
  return findAll(markup, "button").map((b) => ({
    name: (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim(),
    disabled: hasBoolAttr(b.attrs, "disabled"),
  }));
}

function liveButtons(markup: string): string[] {
  return allButtons(markup)
    .filter((b) => !b.disabled && b.name.length > 0)
    .map((b) => b.name);
}

// Value-bearing, GENUINELY-EDITABLE controls: a text-ish <input> or a <textarea> that
// is neither `disabled` nor `readonly`. A checkbox/radio/hidden/submit/button is not a
// value control; a disabled or readonly field is shown but NOT editable. `defaultValue`
// renders as the `value` attribute (input) or the element's text content (textarea) in
// SSR markup. This reads the RENDERED editable affordances — behaviour, not source.
type EditableField = { label: string; value: string; placeholder: string | null };
function editableFields(markup: string): EditableField[] {
  const NON_VALUE = new Set([
    "checkbox",
    "radio",
    "hidden",
    "submit",
    "button",
    "reset",
    "image",
    "file",
  ]);
  const labels = labelTextById(markup);
  const out: EditableField[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (NON_VALUE.has(type)) continue;
    if (hasBoolAttr(attrs, "disabled") || hasBoolAttr(attrs, "readonly")) continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      value: attr(attrs, "value") ?? "",
      placeholder: attr(attrs, "placeholder"),
    });
  }
  for (const t of findAll(markup, "textarea")) {
    if (hasBoolAttr(t.attrs, "disabled") || hasBoolAttr(t.attrs, "readonly")) continue;
    const id = attr(t.attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(t.attrs, "aria-label") || "").trim(),
      value: visibleText(t.inner),
      placeholder: attr(t.attrs, "placeholder"),
    });
  }
  return out;
}

// Does `re` appear in the visible text within `window` chars either side of the first
// occurrence of `needle`? Proves two things are rendered TOGETHER without pinning the
// exact layout.
function nearInText(markup: string, needle: string, re: RegExp, window = 240): boolean {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  const lo = Math.max(0, i - window);
  const hi = Math.min(vt.length, i + needle.length + window);
  return re.test(vt.slice(lo, hi));
}

// Every string value anywhere inside a (possibly nested) value — used to prove a
// submission carries ONLY ciphertext (no plaintext string hides in any field, under
// any property name).
function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

// --- vault keys for the device-seal tests -----------------------------------------
//
// Raw 256-bit vault keys, exactly the bytes createVaultKey() yields in the browser.
// Generated with node:crypto entropy; the seal/decrypt themselves use the module's
// WebCrypto globals, available in the Node test runner.
function freshVaultKey(): Uint8Array<ArrayBuffer> {
  return webcrypto.getRandomValues(new Uint8Array(32));
}

// A high-tier value that must NEVER appear in a submission as plaintext — distinctive
// so its presence anywhere in the payload is unambiguous.
const SECRET_VALUE = "PA-ZX4417-must-never-leak";

// ================================================================================
// AC1 — low-tier fields render EDITABLE in place.
// ================================================================================

test("renders each low-tier field as an editable control bearing its current value", () => {
  const markup = render(base({ lowTierFields: [EMAIL, PHONE], highTierFields: [] }));
  const fields = editableFields(markup);

  // The value is matched directly, so the assertion does not depend on how the label
  // is worded — only that the field is rendered editable (not disabled/readonly) and
  // carries the person's current value.
  assert.ok(
    fields.some((f) => f.value === EMAIL.value),
    `the low-tier email must render as an editable control bearing its value "${EMAIL.value}"; editable fields=${JSON.stringify(fields)}`,
  );
  assert.ok(
    fields.some((f) => f.value === PHONE.value),
    `the low-tier phone must render as an editable control bearing its value "${PHONE.value}"; editable fields=${JSON.stringify(fields)}`,
  );
});

// ================================================================================
// AC1 — a postal address carries its "moving on" date.
// ================================================================================

test("renders a postal address with its moving-on date", () => {
  const markup = render(base({ lowTierFields: [ADDRESS_MOVING], highTierFields: [] }));

  // The address value is rendered editable in place.
  assert.ok(
    editableFields(markup).some((f) => f.value === ADDRESS_MOVING.value),
    `the postal address must render editable with its value; editable fields=${JSON.stringify(editableFields(markup))}`,
  );

  // The moving-on date is shown — as the ISO value of a date control, or as the year
  // in the visible, human-formatted text — and it is presented as a "moving" date.
  const movingDateShown =
    markup.includes("2027-09-15") || /\b2027\b/.test(visibleText(markup));
  assert.ok(
    movingDateShown,
    `the postal address must show its moving-on date (2027-09-15); markup=${markup}`,
  );
  assert.match(
    visibleText(markup),
    /moving/i,
    `the moving-on date must be presented as a "moving on" date in words; text="${visibleText(markup)}"`,
  );
});

// ================================================================================
// AC1 — high-tier fields render LOCKED, each with its label and tier, never a value.
// ================================================================================

test("lists each high-tier field with its label and tier, shown locked (never editable)", () => {
  const markup = render(base({ lowTierFields: [], highTierFields: [PASSPORT, DOB] }));
  const text = visibleText(markup);

  // Each high-tier field is listed with its label...
  assert.ok(text.includes(PASSPORT.label), `the high-tier Passport label must be listed; text="${text}"`);
  assert.ok(text.includes(DOB.label), `the high-tier Date of birth label must be listed; text="${text}"`);

  // ...and its tier, shown near the label (words + the tier, not colour alone).
  assert.ok(
    nearInText(markup, PASSPORT.label, /high[\s-]?tier|\bhigh\b/i),
    `the high-tier Passport must show its tier near its label; text="${text}"`,
  );
  assert.ok(
    nearInText(markup, DOB.label, /high[\s-]?tier|\bhigh\b/i),
    `the high-tier Date of birth must show its tier near its label; text="${text}"`,
  );

  // Values are shown LOCKED: a high-tier field is never a genuinely-editable value
  // control. Scoped to each high-tier field's own label (a locked/readonly display is
  // fine; an editable value field for it is the violation we catch), so an unrelated
  // editable control elsewhere never fails this for the wrong reason.
  const editableLabels = editableFields(markup).map((f) => f.label.toLowerCase());
  for (const hf of [PASSPORT, DOB]) {
    assert.ok(
      !editableLabels.some((l) => l.includes(hf.label.toLowerCase())),
      `high-tier field "${hf.label}" must be shown locked, not as an editable value control; editable fields=${JSON.stringify(editableFields(markup))}`,
    );
  }

  // The locked state is conveyed in words (not colour alone), per the design rules.
  assert.match(
    text,
    /lock|on your device|released only|only when you (approve|allow|release)|approve/i,
    `high-tier fields must show their locked state in words; text="${text}"`,
  );
});

test("never exposes a high-tier value or a ciphertext envelope", () => {
  // The view is only ever handed high-tier METADATA (no value, no ciphertext), so a
  // `v1:` envelope could only appear if the component fabricated/leaked one. Scoped to
  // this component's own output.
  const markup = render(base({ lowTierFields: [], highTierFields: [PASSPORT, DOB] }));
  assert.ok(
    !/\bv1:[A-Za-z0-9+/=]+/.test(markup),
    `no high-tier ciphertext envelope may appear in the view; markup=${markup}`,
  );
});

// ================================================================================
// AC3 — a "Raise to high tier" control for each low-tier field (and none for a
// field that is already high tier).
// ================================================================================

test("offers a live Raise-to-high-tier control for each low-tier field", () => {
  const markup = render(base({ lowTierFields: [EMAIL, PHONE], highTierFields: [PASSPORT] }));
  const raiseControls = liveButtons(markup).filter((n) => /raise/i.test(n));

  // One raise control per low-tier field — and the already-high Passport adds none.
  assert.equal(
    raiseControls.length,
    2,
    `there must be a live "Raise to high tier" control for each of the 2 low-tier fields (and none for the high-tier field); raise controls=${JSON.stringify(raiseControls)}, all live=${JSON.stringify(liveButtons(markup))}`,
  );
});

// ================================================================================
// AC2 — an "Add a high-tier detail" control, closed by default.
// ================================================================================

test("offers a live Add-high-tier-detail control", () => {
  const markup = render(base());
  const add = liveButtons(markup).filter((n) => /add/i.test(n) && /high|tier|detail/i.test(n));
  assert.ok(
    add.length >= 1,
    `the screen must offer a live control to add a high-tier detail; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("the add-high-tier panel is closed by default — no value-entry field until adding", () => {
  // With no low-tier field present and `addingHighTier` omitted, the add panel is
  // closed, so there is no editable value-entry field at all. (Flipping the prop in
  // the next test opens it — proving the panel is gated on the add moment.)
  const markup = render({ lowTierFields: [], highTierFields: [PASSPORT], addingHighTier: false });
  assert.deepEqual(
    editableFields(markup),
    [],
    `with the add panel closed there must be no value-entry field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
});

// ================================================================================
// AC2 — adding a high-tier detail shows the sensitive-moment explainer (how it is
// protected + who can read it) together with a live value field and confirm control.
// ================================================================================

test("opening the add-high-tier panel shows the protection explainer, a value field and a confirm control", () => {
  const markup = render({ lowTierFields: [], highTierFields: [], addingHighTier: true });
  const text = visibleText(markup);

  // HOW it is protected — plain words about it being sealed/locked to the device.
  assert.match(
    text,
    /lock|on your device|encrypt|stays on your|never leaves your device/i,
    `the add panel must explain HOW the detail is protected (locked/sealed on your device); text="${text}"`,
  );
  // WHO can ever read it — released only when the person approves; no one else.
  assert.match(
    text,
    /only you|no one else|nobody else|only when you (approve|allow|release)|released only|you approve/i,
    `the add panel must explain WHO can ever read it (only when you approve); text="${text}"`,
  );

  // A live value-entry field to type the new detail into...
  assert.ok(
    editableFields(markup).length >= 1,
    `the add panel must offer a live value-entry field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
  // ...and a live control to confirm/add it (the explicit sensitive-moment confirm).
  assert.ok(
    liveButtons(markup).some((n) => /add|save|confirm|continue/i.test(n)),
    `the add panel must offer a live confirm/add control; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

// ================================================================================
// AC2 — the value is sealed with the vault key ON THE DEVICE before it is sent:
// only ciphertext leaves. (The one non-render-testable obligation — pinned by
// calling the exported device-seal step and checking what it returns.)
// ================================================================================

test("sealHighTierDetail seals the value under the vault key — the ciphertext round-trips", async () => {
  const vaultKey = freshVaultKey();
  const submission = await sealHighTierDetail(vaultKey, {
    type: "passport",
    label: "Passport",
    value: SECRET_VALUE,
  });

  const envelope = collectStrings(submission).find((s) => s.startsWith("v1:"));
  assert.ok(
    envelope,
    `the submission must carry a sealed "v1:" ciphertext envelope; submission=${JSON.stringify(submission)}`,
  );
  // Sealed to THIS vault key specifically: it decrypts back to the exact plaintext.
  assert.equal(
    await decryptValue(vaultKey, envelope!),
    SECRET_VALUE,
    "the sealed ciphertext must round-trip to the original value under the SAME vault key",
  );
});

test("the sealed submission carries ONLY ciphertext — the plaintext value never leaves", async () => {
  const vaultKey = freshVaultKey();
  const submission = await sealHighTierDetail(vaultKey, {
    type: "passport",
    label: "Passport",
    value: SECRET_VALUE,
  });

  // No field anywhere in the submission is the plaintext value (under any key name)...
  assert.ok(
    !collectStrings(submission).includes(SECRET_VALUE),
    `the plaintext value must never appear in the submission; submission=${JSON.stringify(submission)}`,
  );
  // ...and it does not appear as a substring anywhere in the serialized payload.
  assert.ok(
    !JSON.stringify(submission).includes(SECRET_VALUE),
    `the plaintext value must not appear anywhere in the serialized submission; submission=${JSON.stringify(submission)}`,
  );
  // The metadata (type + label) is preserved — that part is plaintext by design.
  const serialized = JSON.stringify(submission);
  assert.ok(serialized.includes("passport"), `the submission must preserve the field type; submission=${serialized}`);
  assert.ok(serialized.includes("Passport"), `the submission must preserve the field label; submission=${serialized}`);
});

test("the sealed ciphertext is bound to the device vault key — a different key cannot open it", async () => {
  const vaultKey = freshVaultKey();
  const otherKey = freshVaultKey();
  const submission = await sealHighTierDetail(vaultKey, {
    type: "passport",
    label: "Passport",
    value: SECRET_VALUE,
  });
  const envelope = collectStrings(submission).find((s) => s.startsWith("v1:"))!;

  await assert.rejects(
    () => decryptValue(otherKey, envelope),
    "a ciphertext sealed on the device must be openable only with that device's vault key",
  );
});

// ================================================================================
// AC3 — raising a field to high tier RE-SEALS its value on the device: the re-sealed
// value round-trips under the vault key and only ciphertext leaves.
// ================================================================================

test("raising a field re-seals its value on the device (only ciphertext leaves)", async () => {
  const vaultKey = freshVaultKey();
  // The current (decrypted) value of a low-tier field being raised to high tier.
  const raisedValue = "DL-99887766-raise-me";
  const submission = await sealHighTierDetail(vaultKey, {
    type: "custom",
    label: "Driver licence",
    value: raisedValue,
  });

  const envelope = collectStrings(submission).find((s) => s.startsWith("v1:"));
  assert.ok(envelope, `raising must produce a sealed "v1:" ciphertext; submission=${JSON.stringify(submission)}`);
  assert.equal(
    await decryptValue(vaultKey, envelope!),
    raisedValue,
    "the re-sealed value must round-trip under the vault key",
  );
  assert.ok(
    !JSON.stringify(submission).includes(raisedValue),
    `raising must not leak the plaintext value; submission=${JSON.stringify(submission)}`,
  );
});

// ================================================================================
// Design system — colour comes from tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour", () => {
  const variants: IdentityViewProps[] = [
    base(),
    base({ lowTierFields: [ADDRESS_MOVING] }),
    base({ lowTierFields: [], highTierFields: [PASSPORT, DOB] }),
    { lowTierFields: [], highTierFields: [], addingHighTier: true },
  ];
  for (const props of variants) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the identity-view markup, got: ${markup}`,
    );
  }
});

// ================================================================================
// Review fix G1 — details can actually be added and saved, and Cards is reachable.
// ================================================================================

test("each low-tier field is a named control inside a form with a live Save, and a new detail can be added", () => {
  const markup = render(base({ lowTierFields: [EMAIL, ADDRESS_MOVING], highTierFields: [] }));
  const forms = findAll(markup, "form");
  assert.ok(forms.length >= 2, `each low-tier field is its own form; forms=${forms.length}`);
  for (const form of forms) {
    assert.match(form.inner, /<input\b[^>]*name="value"/, "the value control is named so it can be saved");
  }
  assert.match(markup, /<input\b[^>]*name="movingOn"/, "the moving-on date is a named control");
  assert.ok(
    liveButtons(markup).filter((n) => /^save$/i.test(n)).length >= 2,
    `every field has a live Save; live=${JSON.stringify(liveButtons(markup))}`,
  );
  assert.ok(
    liveButtons(markup).some((n) => /^add a detail$/i.test(n)),
    `an "Add a detail" control is offered; live=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("a person with no details yet is told what to add and offered the add control", () => {
  const markup = render(base({ lowTierFields: [], highTierFields: [] }));
  assert.match(visibleText(markup), /add your name/i);
  assert.ok(liveButtons(markup).some((n) => /^add a detail$/i.test(n)));
});

// The shell's section tabs (Identity / Cards) are the Vault's one tab row — reaching
// Cards from here (review fix G1) — so the view adds no second, duplicate Vault nav.
test("the Vault reaches Cards through the shell's section tabs, with no duplicate tab row in the view", () => {
  const markup = render(base({ lowTierFields: [], highTierFields: [] }));
  assert.doesNotMatch(markup, /<nav\b/i, "the identity view renders no navigation of its own");
  const tabs = sectionNavigation("/vault");
  assert.deepEqual(
    tabs.items.map((item) => [item.href, item.active]),
    [
      ["/vault", true],
      ["/vault/cards", false],
    ],
    "the shell's Vault tabs mark Identity current and link to Cards",
  );
});

test("the page title uses the house heading style", () => {
  const h1 = /<h1\b([^>]*)>([\s\S]*?)<\/h1>/.exec(render(base()));
  assert.ok(h1, "the view has a page heading");
  assert.equal(visibleText(h1[2]), "About you");
  const cls = (attr(h1[1], "class") ?? "").split(/\s+/);
  for (const token of ["text-2xl", "font-semibold", "tracking-tight", "text-fg"]) {
    assert.ok(cls.includes(token), `the h1 carries ${token}; class="${cls.join(" ")}"`);
  }
});

// ================================================================================
// Organisation pass — the details are grouped by purpose under their tier, as divider
// rows (no card per field, so an opened panel is never a card inside a card).
// ================================================================================

// The h3 group headings in document order, with the visible text of each group's rows.
function groups(markup: string): Array<{ title: string; text: string }> {
  const out: Array<{ title: string; text: string }> = [];
  for (const m of markup.matchAll(/<section\b[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gi)) {
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(m[2]);
    if (heading) out.push({ title: visibleText(heading[1]), text: visibleText(m[2]) });
  }
  return out;
}

const LANGUAGE: LowTierField = { id: "lf-lang", userId: OWNER, kind: "language", value: "Auslan and English", movingOn: null };
const PREFERRED: LowTierField = { id: "lf-pref", userId: OWNER, kind: "preferred_name", value: "Addie", movingOn: null };
const REGO: HighTierField = { id: "hf-rego", userId: OWNER, type: "car_registration", label: "Ute rego", tier: "high" };
const CUSTOM: HighTierField = { id: "hf-custom", userId: OWNER, type: "custom", label: "Medicare number", tier: "high" };

test("everyday details are grouped by purpose — names, contact, preferences — in that order", () => {
  const markup = render(
    base({ lowTierFields: [LANGUAGE, EMAIL, NAME, ADDRESS_MOVING, PREFERRED, PHONE], highTierFields: [] }),
  );
  const found = groups(markup);
  assert.deepEqual(
    found.map((g) => g.title),
    ["Names", "Contact", "Preferences"],
    `the everyday details are grouped by purpose; groups=${JSON.stringify(found.map((g) => g.title))}`,
  );
  const [names, contact, prefs] = found;
  assert.ok(names.text.includes("Name") && names.text.includes("Preferred name"), `names hold the name fields; text="${names.text}"`);
  assert.ok(!names.text.includes("Email"), "a contact field never lands under names");
  for (const label of ["Email", "Phone", "Postal address"]) {
    assert.ok(contact.text.includes(label), `contact holds ${label}; text="${contact.text}"`);
  }
  assert.ok(prefs.text.includes("Language") && !prefs.text.includes("Email"), `preferences hold the language; text="${prefs.text}"`);
  // Each group shows how many details it holds.
  assert.match(contact.text, /\b3\b/, "the contact group shows its count");
});

test("a purpose with no details is not shown as an empty group", () => {
  const found = groups(render(base({ lowTierFields: [EMAIL], highTierFields: [] })));
  assert.deepEqual(found.map((g) => g.title), ["Contact"]);
});

test("protected details are grouped by kind — identity documents, then vehicle, then other", () => {
  const markup = render(base({ lowTierFields: [], highTierFields: [CUSTOM, REGO, PASSPORT, DOB] }));
  const found = groups(markup);
  assert.deepEqual(
    found.map((g) => g.title),
    ["Identity", "Vehicle", "Other"],
    `protected details are grouped by kind; groups=${JSON.stringify(found.map((g) => g.title))}`,
  );
  assert.ok(found[0].text.includes("Passport") && found[0].text.includes("Date of birth"), `identity holds passport + birth date; text="${found[0].text}"`);
  assert.ok(found[1].text.includes("Ute rego"), "vehicle holds the registration");
  assert.ok(found[2].text.includes("Medicare number"), "other holds the custom detail");
  // Still locked: the tier is stated in words on every protected row.
  assert.equal((visibleText(markup).match(/High tier/g) ?? []).length, 4, "every protected detail is shown locked, in words");
});

test("details are divider rows, never a card per field", () => {
  const markup = render(base({ lowTierFields: [NAME, EMAIL, PHONE], highTierFields: [PASSPORT, DOB] }));
  const sections = [...markup.matchAll(/<section\b[^>]*aria-labelledby="[^"]+"[^>]*>([\s\S]*?)<\/section>/gi)];
  assert.ok(sections.length >= 3, `the details render in titled groups; groups=${sections.length}`);
  for (const group of sections) {
    const boxes = [...group[1].matchAll(/class="([^"]*)"/g)]
      .map((m) => m[1].split(/\s+/))
      .filter((cls) => cls.includes("rounded-card") && cls.includes("border") && cls.includes("p-4"));
    assert.equal(boxes.length, 0, `a grouped detail is a divider row, not a card; boxes=${JSON.stringify(boxes)}`);
  }
});
