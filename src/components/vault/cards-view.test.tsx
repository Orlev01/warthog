// E11-S14 — Vault cards view component (src/components/vault/cards-view.tsx).
//
// RED-first: src/components/vault/cards-view.tsx does NOT exist yet, so importing
// `./cards-view` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement
// anything to make these pass.
//
// WHY this component exists (brief "Identity vault"; constitution §17 "No readable
// card numbers or security codes"; design §4.2 device-held vault): the cards page is
// the "Add a card" journey surface. It renders the saved cards FROM PROPS and must:
//   - show each saved card as BRAND + LAST FOUR with its nickname and expiry, and
//     NEVER a full card number or a security code (the view is only ever handed card
//     METADATA — E11-S12 loadVaultPageData.cards — never the number, its ciphertext
//     or a CVV);
//   - offer a Remove control per saved card;
//   - offer an "Add a card" control that, at that sensitive moment, shows the plain
//     sensitive-notice explainer AND the explicit note that the card security code is
//     never stored, offers a BILLING-ADDRESS PICKER drawn from the person's vault
//     addresses, and seals the card NUMBER with the vault key ON THE DEVICE so only
//     ciphertext ever leaves (design §4.2 — the server stores ciphertext only, holds
//     no key; §17 — Warthog never stores a readable number and never a security code).
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The
// real plumbing — holding the unlocked vault key, POSTing the sealed submission, the
// server action that stores it — is wired by E11-S19's live AddCardFlow, which this view
// now mounts for the "add a card" panel (its device behaviour is pinned by
// add-card-flow.test.tsx). This file keeps pinning what CardsView RENDERS. Like the sibling
// identity / rules / consent / notifications views, a PROP (`addingCard`) selects the
// initial state of the conceptually-interactive "add a card" panel, so a render test
// pins each state without clicking anything (no DOM; React component / E2E testing is
// a per-job ADR). We render with `react-dom/server` and read the emitted markup,
// exactly as the sibling component tests do.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given,
// and what the exported device-seal step RETURNS when called — never the source text
// of cards-view.tsx. A later behaviour-preserving refactor (different wrapper
// elements, reworded-but-still-plain copy, extra classes, a different icon, a select
// vs radios for the picker) stays green. The one non-render-testable obligation —
// "the number is sealed with the vault key on the device before save (only ciphertext
// leaves), and the security code is never stored" — is pinned by calling the exported
// pure seal step directly and checking what it returns, which is behaviour (call a
// function, check its output), not source text.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms):
//
//   CardsView({ cards, billingAddresses, addingCard? }):
//     • cards            — the owner's saved cards, METADATA ONLY (exactly
//                          VaultPageData.cards / CardMetadata): { id, userId, brand,
//                          lastFour, expiryMonth, expiryYear, nickname,
//                          billingAddressId } — no number, no ciphertext, no CVV.
//                          Each is rendered as brand + last four with its nickname and
//                          expiry (display only, never an editable value field), and
//                          each gets a Remove control.
//     • billingAddresses — the person's vault postal addresses the add-card billing
//                          picker chooses from: { id, value }. Offered as a picker when
//                          adding.
//     • addingCard?      — selects the initial state of the "add a card" panel (the
//                          identity-view `draft` idiom). When true the panel is OPEN:
//                          it shows the sensitive-moment explainer, the explicit
//                          "security code is never stored" note, the billing-address
//                          picker, a live card-number value field, and a live
//                          confirm/add control. Defaults to CLOSED.
//
//   sealCard(vaultKey, input): Promise<submission>
//     • The device-seal step the Add-a-card control runs before anything leaves the
//       device: it seals `input.number` under the in-memory vault key and returns the
//       submission the server stores (the NewCard-minus-userId shape) — carrying ONLY
//       the sealed `numberCiphertext` (a `v1:` envelope that round-trips under the SAME
//       vault key via decryptValue), the derived `lastFour` (the number's last four
//       digits) and the plaintext metadata (brand, expiryMonth, expiryYear, nickname,
//       billingAddressId). It NEVER carries the full number and NEVER a security code.
//     • vaultKey — the raw 256-bit vault key bytes (as createVaultKey yields).
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { CardsView, sealCard, createRemoveCardFlow, createChangeBillingFlow, removingDeletesBillingAddress } from "./cards-view";
import { decryptValue } from "@/client/vault/values";

// --- the prop shapes this task renders (described here as the contract; declared
// locally so the component test never couples to the server db modules) -----------

type SavedCard = {
  id: string;
  userId: string;
  brand: string;
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
  nickname: string;
  billingAddressId: string;
};

type VaultAddress = {
  id: string;
  value: string;
};

type CardsViewProps = {
  cards: ReadonlyArray<SavedCard>;
  billingAddresses: ReadonlyArray<VaultAddress>;
  addingCard?: boolean;
  // E11-S19 supersession: "Add a card" is now a LIVE on-device flow (AddCardFlow), so the
  // open panel needs its submit seam — the page's addCard server action that stores the
  // sealed submission. Rendered here with a no-op so the control is live; the device flow's
  // own behaviour (create/unlock the vault key → seal → submit) is pinned by
  // add-card-flow.test.tsx, not here.
  addCard?: (submission: unknown) => Promise<{ ok: boolean }>;
};

// --- fixtures ---------------------------------------------------------------------
//
// Distinctive, recognisable values so every "renders this value" / "never leaks this
// value" assertion is honest — the string can only be the field under test.

const OWNER = "user-abc";

const CARD_A: SavedCard = {
  id: "card-visa",
  userId: OWNER,
  brand: "Visa",
  lastFour: "4242",
  expiryMonth: 11,
  expiryYear: 2029,
  nickname: "Everyday spending",
  billingAddressId: "addr-home",
};
const CARD_B: SavedCard = {
  id: "card-mc",
  userId: OWNER,
  brand: "Mastercard",
  lastFour: "7781",
  expiryMonth: 3,
  expiryYear: 2028,
  nickname: "Travel backup",
  billingAddressId: "addr-work",
};

const ADDR_HOME: VaultAddress = { id: "addr-home", value: "12 Banksia Street, Perth" };
const ADDR_WORK: VaultAddress = { id: "addr-work", value: "5 Marine Parade, Fremantle" };

// The submit seam the now-live add panel needs (E11-S19). A no-op here — these tests only
// render; the device flow is never submitted. Its behaviour lives in add-card-flow.test.tsx.
const noopAddCard = async () => ({ ok: true as const });

function base(overrides: Partial<CardsViewProps> = {}): CardsViewProps {
  return {
    cards: [CARD_A, CARD_B],
    billingAddresses: [ADDR_HOME, ADDR_WORK],
    addCard: noopAddCard,
    ...overrides,
  };
}

function render(props: CardsViewProps): string {
  return renderToStaticMarkup(<CardsView {...props} />);
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

// --- expiry matchers (tolerant of MM/YY, MM/YYYY, zero-padding or a month name) ----

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function monthRe(month: number): RegExp {
  return new RegExp(`\\b0?${month}\\b|${MONTH_NAMES[month - 1].slice(0, 3)}`, "i");
}
function yearRe(year: number): RegExp {
  // The full year (2029) or the two-digit short form (29, bounded so it is not matched
  // inside the full year).
  return new RegExp(`${year}|\\b${year % 100}\\b`);
}

// --- vault keys for the device-seal tests -----------------------------------------
//
// Raw 256-bit vault keys, exactly the bytes createVaultKey() yields in the browser.
// Generated with node:crypto entropy; the seal/decrypt themselves use the module's
// WebCrypto globals, available in the Node test runner.
function freshVaultKey(): Uint8Array<ArrayBuffer> {
  return webcrypto.getRandomValues(new Uint8Array(32));
}

// A full card number that must NEVER appear in a submission as plaintext — its last
// four ("4242") is the only part that may legitimately survive (as `lastFour`).
const FULL_NUMBER = "4111111111114242";
// A security code (CVV) that must NEVER appear ANYWHERE in a submission — the server
// stores no security code in any form (constitution §17).
const SECURITY_CODE = "SC-917-never-store";

// The card a person enters, before the number is sealed on the device. Declared loosely
// (the `securityCode` is deliberately present to prove it is dropped, whatever the
// component's own input type names it).
function cardInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brand: "Visa",
    number: FULL_NUMBER,
    securityCode: SECURITY_CODE,
    expiryMonth: 11,
    expiryYear: 2029,
    nickname: "Everyday spending",
    billingAddressId: "addr-home",
    ...overrides,
  };
}

// ================================================================================
// AC1 — each saved card renders as brand + last four with its nickname and expiry.
// ================================================================================

test("renders each saved card as brand + last four with its nickname and expiry", () => {
  const markup = render(base());
  const text = visibleText(markup);

  for (const card of [CARD_A, CARD_B]) {
    assert.ok(text.includes(card.brand), `the card brand "${card.brand}" must be shown; text="${text}"`);
    assert.ok(
      text.includes(card.lastFour),
      `the card last four "${card.lastFour}" must be shown; text="${text}"`,
    );
    assert.ok(
      text.includes(card.nickname),
      `the card nickname "${card.nickname}" must be shown; text="${text}"`,
    );

    // brand + last four + expiry are grouped with this card (its nickname anchors the
    // card) — without pinning the exact layout.
    assert.ok(
      nearInText(markup, card.nickname, new RegExp(card.brand, "i")),
      `the brand "${card.brand}" must be shown with its card "${card.nickname}"; text="${text}"`,
    );
    assert.ok(
      nearInText(markup, card.nickname, new RegExp(card.lastFour)),
      `the last four "${card.lastFour}" must be shown with its card "${card.nickname}"; text="${text}"`,
    );
    assert.ok(
      nearInText(markup, card.nickname, monthRe(card.expiryMonth)),
      `the expiry month (${card.expiryMonth}) must be shown with its card "${card.nickname}"; text="${text}"`,
    );
    assert.ok(
      nearInText(markup, card.nickname, yearRe(card.expiryYear)),
      `the expiry year (${card.expiryYear}) must be shown with its card "${card.nickname}"; text="${text}"`,
    );
  }
});

// ================================================================================
// AC1 — never a full card number or a security code / ciphertext envelope. The view
// is only ever handed card METADATA (no number, no ciphertext, no CVV), so either
// could only appear if the component fabricated/leaked one. Scoped to this component's
// own output.
// ================================================================================

test("never renders a full card number or a ciphertext envelope", () => {
  const markup = render(base());

  // No `v1:` number-ciphertext envelope appears in the view.
  assert.ok(
    !/\bv1:[A-Za-z0-9+/=]+/.test(markup),
    `no card number ciphertext envelope may appear in the view; markup=${markup}`,
  );
  // No long digit run that could be a full PAN (a real card number is 13+ digits; the
  // metadata only ever carries a 4-digit last-four and a 4-digit year).
  assert.ok(
    !/\d{12,}/.test(visibleText(markup)),
    `no full card number may appear in the view; text="${visibleText(markup)}"`,
  );
});

test("saved cards render display-only — no editable value field when not adding", () => {
  // With `addingCard` omitted, the add panel is closed, so the saved cards are shown as
  // read-only brand/last-four/nickname/expiry metadata — there is NO editable value
  // field anywhere (the add panel in a later test opens the only editable fields).
  const markup = render(base());
  assert.deepEqual(
    editableFields(markup),
    [],
    `saved cards must render display-only with the add panel closed; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
});

// ================================================================================
// What — a Remove control per saved card.
// ================================================================================

test("offers a live Remove control for each saved card", () => {
  const markup = render(base({ cards: [CARD_A, CARD_B] }));
  const removeControls = liveButtons(markup).filter((n) => /remove|delete/i.test(n));
  assert.equal(
    removeControls.length,
    2,
    `there must be a live Remove control for each of the 2 saved cards; remove controls=${JSON.stringify(removeControls)}, all live=${JSON.stringify(liveButtons(markup))}`,
  );
});

// ================================================================================
// AC2 — an "Add a card" control, closed by default.
// ================================================================================

test("offers a live Add-a-card control", () => {
  const markup = render(base());
  const add = liveButtons(markup).filter((n) => /add/i.test(n) && /card/i.test(n));
  assert.ok(
    add.length >= 1,
    `the screen must offer a live control to add a card; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("the add-card panel is closed by default — no value-entry field until adding", () => {
  const markup = render({ cards: [CARD_A], billingAddresses: [ADDR_HOME], addingCard: false });
  assert.deepEqual(
    editableFields(markup),
    [],
    `with the add panel closed there must be no value-entry field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
});

// ================================================================================
// AC2 — adding a card shows the sensitive-moment explainer AND the explicit
// "security code is never stored" note, offers a billing-address picker from the
// vault, a live card-number field and a live confirm/add control.
// ================================================================================

test("opening the add-card panel shows the sensitive-moment explainer", () => {
  const markup = render(base({ addingCard: true }));
  const text = visibleText(markup);
  // A plain slow-down explainer: either the generic sensitive-step copy or the
  // device-protection explanation (the number is sealed/locked on the device).
  assert.match(
    text,
    /sensitive|take a moment|before (it|this) (goes|is saved)|lock|on your device|seal|encrypt|never leaves your device/i,
    `the add panel must show the sensitive-moment explainer; text="${text}"`,
  );
});

test("the add-card panel shows the explicit 'security code is never stored' note", () => {
  const markup = render(base({ addingCard: true }));
  const text = visibleText(markup);

  // The note refers to the card security code (plain Australian English, so "security
  // code" is expected, but a "CVV"/"CVC" wording is tolerated)...
  assert.match(
    text,
    /security code|\bCVV\b|\bCVC\b/i,
    `the add panel must refer to the card security code; text="${text}"`,
  );
  // ...and says, near that reference, that it is never stored / kept / saved.
  const codeTerm = /security code/i.test(text) ? "security code" : /CVC/i.test(text) ? "CVC" : "CVV";
  const neverPhrase = /\b(never|not|isn'?t|won'?t|don'?t|do not|no)\b[^.]*\b(stor|kept|keep|saved|save)\w*/i;
  assert.ok(
    nearInText(markup, codeTerm, neverPhrase),
    `the add panel must note the card security code is never stored; text="${text}"`,
  );
});

test("the add-card panel offers a billing-address picker drawn from the vault", () => {
  const markup = render(base({ addingCard: true, billingAddresses: [ADDR_HOME, ADDR_WORK] }));
  const text = visibleText(markup);

  // Both of the person's vault addresses are offered to choose from.
  for (const addr of [ADDR_HOME, ADDR_WORK]) {
    assert.ok(
      text.includes(addr.value),
      `the billing-address picker must offer the vault address "${addr.value}"; text="${text}"`,
    );
  }
  // It is a genuine picker (a <select>, option list, or radio set), not just printed
  // text — at least two selectable choices for the two addresses.
  const options = findAll(markup, "option").length;
  const radios = [...markup.matchAll(/<input\b[^>]*type="radio"[^>]*>/gi)].length;
  const isPicker = /<select\b/i.test(markup) || options >= 2 || radios >= 2;
  assert.ok(
    isPicker,
    `the vault addresses must be offered as a selectable picker; markup=${markup}`,
  );
});

test("opening the add-card panel offers a live card-number field and a live confirm control", () => {
  const markup = render(base({ addingCard: true }));

  // A live value-entry field to type the card number into (at least one editable field).
  assert.ok(
    editableFields(markup).length >= 1,
    `the add panel must offer a live card-number value field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
  // ...and a live control to confirm/add it (the explicit sensitive-moment confirm).
  assert.ok(
    liveButtons(markup).some((n) => /add|save|confirm|continue/i.test(n)),
    `the add panel must offer a live confirm/add control; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

// ================================================================================
// AC2 — the card NUMBER is sealed with the vault key ON THE DEVICE before save: only
// ciphertext leaves, the last four is derived, the metadata is preserved, and NO
// security code is ever carried. (The non-render-testable obligation — pinned by
// calling the exported device-seal step and checking what it returns.)
// ================================================================================

test("sealCard seals the number under the vault key — the ciphertext round-trips", async () => {
  const vaultKey = freshVaultKey();
  const submission = await sealCard(vaultKey, cardInput());

  const envelope = collectStrings(submission).find((s) => s.startsWith("v1:"));
  assert.ok(
    envelope,
    `the submission must carry a sealed "v1:" number-ciphertext envelope; submission=${JSON.stringify(submission)}`,
  );
  // Sealed to THIS vault key specifically: it decrypts back to the exact full number.
  assert.equal(
    await decryptValue(vaultKey, envelope!),
    FULL_NUMBER,
    "the sealed ciphertext must round-trip to the original card number under the SAME vault key",
  );
});

test("the sealed submission carries ONLY ciphertext — the full number never leaves", async () => {
  const vaultKey = freshVaultKey();
  const submission = await sealCard(vaultKey, cardInput());

  // No field anywhere in the submission is the full number (under any key name)...
  assert.ok(
    !collectStrings(submission).includes(FULL_NUMBER),
    `the full card number must never appear in the submission; submission=${JSON.stringify(submission)}`,
  );
  // ...and it does not appear as a substring anywhere in the serialized payload.
  assert.ok(
    !JSON.stringify(submission).includes(FULL_NUMBER),
    `the full card number must not appear anywhere in the serialized submission; submission=${JSON.stringify(submission)}`,
  );
});

test("the sealed submission never carries the card security code in any form", async () => {
  const vaultKey = freshVaultKey();
  // The input carries a security code; the submission must drop it entirely (§17).
  const submission = await sealCard(vaultKey, cardInput());

  assert.ok(
    !collectStrings(submission).includes(SECURITY_CODE),
    `the card security code must never appear in the submission; submission=${JSON.stringify(submission)}`,
  );
  assert.ok(
    !JSON.stringify(submission).includes(SECURITY_CODE),
    `the card security code must not appear anywhere in the serialized submission; submission=${JSON.stringify(submission)}`,
  );
});

test("sealCard derives the last four from the number and preserves the card metadata", async () => {
  const vaultKey = freshVaultKey();
  const submission = (await sealCard(vaultKey, cardInput())) as Record<string, unknown>;

  // The last four is the number's last four digits — never the whole number.
  assert.equal(
    submission.lastFour,
    FULL_NUMBER.slice(-4),
    `the submission must carry the derived last four (${FULL_NUMBER.slice(-4)}); submission=${JSON.stringify(submission)}`,
  );
  // The plaintext metadata the server stores is preserved exactly.
  assert.equal(submission.brand, "Visa", "the submission must preserve the brand");
  assert.equal(submission.expiryMonth, 11, "the submission must preserve the expiry month");
  assert.equal(submission.expiryYear, 2029, "the submission must preserve the expiry year");
  assert.equal(submission.nickname, "Everyday spending", "the submission must preserve the nickname");
  assert.deepEqual(
    (submission as unknown as { billing: unknown }).billing,
    { source: "postal", id: "addr-home" },
    "the submission must preserve the chosen billing-address reference",
  );
  // The sealed number is carried under the `numberCiphertext` field (the NewCard
  // contract the server action stores verbatim).
  assert.ok(
    typeof submission.numberCiphertext === "string" && submission.numberCiphertext.startsWith("v1:"),
    `the submission must carry the sealed number as numberCiphertext ("v1:" envelope); submission=${JSON.stringify(submission)}`,
  );
});

test("the sealed ciphertext is bound to the device vault key — a different key cannot open it", async () => {
  const vaultKey = freshVaultKey();
  const otherKey = freshVaultKey();
  const submission = await sealCard(vaultKey, cardInput());
  const envelope = collectStrings(submission).find((s) => s.startsWith("v1:"))!;

  await assert.rejects(
    () => decryptValue(otherKey, envelope),
    "a card number sealed on the device must be openable only with that device's vault key",
  );
});

// ================================================================================
// Design system — colour comes from tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour", () => {
  const variants: CardsViewProps[] = [
    base(),
    base({ cards: [] }),
    base({ addingCard: true }),
    { cards: [CARD_A], billingAddresses: [ADDR_HOME], addingCard: true, addCard: noopAddCard },
  ];
  for (const props of variants) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the cards-view markup, got: ${markup}`,
    );
  }
});


// ================================================================================
// Review fix G12 — Remove actually removes (after a confirm step), reporting the outcome.
// It used to be a live button with no handler, although the cards actions implement
// removeCard — a stored card could never be deleted.
// ================================================================================

test("Remove asks first, then calls removeCard with exactly that card's id, once", async () => {
  const calls: unknown[] = [];
  const flow = createRemoveCardFlow({
    cardId: CARD_A.id,
    removeCard: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  });
  assert.equal(flow.getState().stage, "idle");
  flow.ask();
  assert.equal(flow.getState().stage, "confirming", "a confirm step comes before anything is deleted");
  assert.deepEqual(calls, []);
  await Promise.all([flow.confirm(), flow.confirm()]);
  assert.deepEqual(calls, [{ cardId: CARD_A.id }], "removed once, by this card's id");
  assert.equal(flow.getState().stage, "removed");
});

test("Keep it backs out without removing; a refused removal says so in plain words", async () => {
  let called = 0;
  const kept = createRemoveCardFlow({
    cardId: CARD_A.id,
    removeCard: async () => {
      called += 1;
      return { ok: true };
    },
  });
  kept.ask();
  kept.cancel();
  assert.equal(kept.getState().stage, "idle");
  assert.equal(called, 0);

  const refused = createRemoveCardFlow({ cardId: CARD_A.id, removeCard: async () => ({ ok: false, reason: "not_found" }) });
  refused.ask();
  await refused.confirm();
  assert.equal(refused.getState().stage, "error");
  assert.ok(refused.getState().error && !/not_found/.test(refused.getState().error!));
});

test("each saved card's Remove names the card for assistive technology", () => {
  const markup = render(base({ cards: [CARD_A], removeCard: async () => ({ ok: true }) }));
  assert.match(markup, /<button\b[^>]*aria-label="Remove Everyday spending"/);
});

// ================================================================================
// Organisation pass — the shell's section tabs (Identity / Cards) are the Vault's one
// tab row, so the view adds no duplicate; the title uses the house heading style.
// ================================================================================

test("the cards view adds no second Vault tab row of its own", () => {
  assert.doesNotMatch(render(base()), /<nav\b/i, "the cards view renders no navigation of its own");
});

test("the cards page title matches its tab and sits in the shared heading band", () => {
  const markup = render(base());
  const band = /<header class="wh-page-heading">([\s\S]*?)<\/header>/.exec(markup);
  assert.ok(band, "the view opens with the shared heading band");
  assert.match(band[1], /<h1>Cards<\/h1>/);
  assert.match(band[1], /approve every purchase/i, "the band says what the page is for");
});

test("saved cards are divider rows in one panel, with a destructive Remove and an inline empty state", () => {
  const withCards = render(base({ cards: [CARD_A, CARD_B] }));
  assert.match(withCards, /<h2[^>]*>Saved cards<\/h2>/);
  assert.match(withCards, /<button[^>]*class="[^"]*text-danger[^"]*"[^>]*aria-label="Remove [^"]+"/, "Remove is styled as destructive");
  const empty = render(base({ cards: [] }));
  assert.match(empty, /class="wh-panel-empty"/, "an empty list is an inline state inside the panel, not a bare line");
});

test("the add-card explainer states the release as it happens, with no absolute claims (content-31)", () => {
  const text = visibleText(render(base({ addingCard: true })));
  assert.doesNotMatch(text, /can never read|not anywhere|no one else/i, `no absolute security claim; text="${text}"`);
  assert.match(text, /encrypted on this device/i);
  assert.match(text, /passed through Warthog once/i);
  assert.match(text, /type it each time you approve a purchase/i, "the security code note says what happens instead");
});


// ================================================================================
// Card billing addresses (docs/adr/card-billing-addresses.md): each saved card shows its billing
// address and can change it; a card without one says so and offers to add one.
// ================================================================================

const HOME_CHOICE = { id: "addr-home", value: "12 Banksia Street, Perth", source: "postal" as const, upcoming: false, movingOn: null, usedBy: ["Everyday spending"] };
const BOX_CHOICE = { id: "box-1", value: "PO Box 12, Bondi Junction", source: "billing" as const, upcoming: false, movingOn: null, usedBy: ["Travel backup"] };
const renderReal = (props: React.ComponentProps<typeof CardsView>) => renderToStaticMarkup(<CardsView {...props} />);

test("each saved card shows its billing address, with a Change named for the card", () => {
  const markup = renderReal({
    cards: [
      { ...CARD_A, billingEntryId: null, billing: { text: "12 Banksia Street, Perth", source: "postal" } },
      { ...CARD_B, billingAddressId: null, billingEntryId: "box-1", billing: { text: "PO Box 12, Bondi Junction", source: "billing" } },
    ],
    billingAddresses: [HOME_CHOICE, BOX_CHOICE],
    changeBillingAddress: async () => ({ ok: true }),
  });
  const text = visibleText(markup);
  assert.match(text, /Billing address: 12 Banksia Street, Perth/);
  assert.match(text, /Billing address: PO Box 12, Bondi Junction/);
  assert.match(markup, /<button\b[^>]*aria-label="Change the billing address for Everyday spending"[^>]*>[\s\S]*?Change<\/button>/);
  assert.ok(!/<form\b[^>]*aria-label="Change billing address/.test(markup), "the change form opens only when asked");
});

test("a card with no billing address says so and offers to add one", () => {
  const markup = renderReal({
    cards: [{ ...CARD_A, billingAddressId: null, billingEntryId: null, billing: null }],
    billingAddresses: [],
  });
  assert.match(visibleText(markup), /No billing address yet/);
  assert.match(markup, /<button\b[^>]*aria-label="Add a billing address for Everyday spending"[^>]*>[\s\S]*?Add one<\/button>/);
});

test("Change opens on the card's current address and saves the new choice once", async () => {
  const calls: unknown[] = [];
  const flow = createChangeBillingFlow({
    cardId: CARD_B.id,
    current: { source: "billing", id: "box-1" },
    choices: [HOME_CHOICE, BOX_CHOICE],
    changeBillingAddress: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  });
  assert.equal(flow.getState().stage, "idle");
  flow.open();
  assert.equal(flow.getState().stage, "editing");
  assert.equal(flow.getState().key, "billing:box-1", "the card's current address starts chosen");
  flow.choose("postal:addr-home");
  await Promise.all([flow.save(), flow.save()]);
  assert.deepEqual(calls, [{ cardId: CARD_B.id, billing: { source: "postal", id: "addr-home" } }], "saved once");
  assert.equal(flow.getState().stage, "saved");
});

test("Change can type a different address; a missing one or a refusal is said in plain words", async () => {
  const calls: unknown[] = [];
  const flow = createChangeBillingFlow({
    cardId: CARD_A.id,
    current: null,
    choices: [HOME_CHOICE],
    changeBillingAddress: async (input) => {
      calls.push(input);
      return { ok: false, reason: "billing_address_not_found" };
    },
  });
  flow.open();
  assert.equal(flow.getState().key, "", "with no current address nothing starts chosen");
  await flow.save();
  assert.equal(flow.getState().stage, "error");
  assert.match(flow.getState().error ?? "", /Choose a billing address/);
  assert.deepEqual(calls, [], "nothing is sent without a choice");

  flow.choose("new");
  flow.setNewValue("  PO Box 3, Manly  ");
  await flow.save();
  assert.deepEqual(calls, [{ cardId: CARD_A.id, billing: { source: "new", value: "PO Box 3, Manly" } }]);
  assert.equal(flow.getState().stage, "error");
  assert.match(flow.getState().error ?? "", /no longer saved/);
  assert.ok(!/billing_address_not_found/.test(flow.getState().error ?? ""));

  const thrown = createChangeBillingFlow({ cardId: CARD_A.id, choices: [HOME_CHOICE], changeBillingAddress: async () => { throw new Error("offline"); } });
  thrown.open();
  thrown.choose("postal:addr-home");
  await thrown.save();
  assert.match(thrown.getState().error ?? "", /couldn't change the billing address/);

  const kept = createChangeBillingFlow({ cardId: CARD_A.id, choices: [HOME_CHOICE], changeBillingAddress: async () => ({ ok: true }) });
  kept.open();
  kept.cancel();
  assert.equal(kept.getState().stage, "idle");
});

test("removing the last card that uses a card-only address deletes the address too (and says so)", () => {
  const travel = { ...CARD_B, billingAddressId: null, billingEntryId: "box-1" };
  assert.equal(removingDeletesBillingAddress(travel, [BOX_CHOICE]), true, "its only card");
  assert.equal(removingDeletesBillingAddress(travel, [{ ...BOX_CHOICE, usedBy: ["Travel backup", "Everyday spending"] }]), false, "another card still uses it");
  assert.equal(removingDeletesBillingAddress({ ...CARD_A, billingEntryId: null }, [HOME_CHOICE]), false, "an About you address is never deleted");
});
