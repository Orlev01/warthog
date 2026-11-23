// A card's billing address choice (src/components/vault/billing-address-choice.tsx;
// docs/adr/card-billing-addresses.md): the person's About you postal addresses and the addresses
// kept with their cards, each with where it comes from, plus "A different billing address". With
// nothing saved, the address field shows straight away.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BILLING_CHOOSE_COPY,
  BILLING_TOO_LONG_COPY,
  BILLING_TYPE_COPY,
  BillingAddressChoice,
  billingSelection,
  choiceKey,
  choiceSource,
  initialBillingKey,
  NEW_BILLING_KEY,
  type BillingChoiceView,
} from "./billing-address-choice";

const HOME: BillingChoiceView = { id: "home", value: "12 Banksia Street, Perth", source: "postal", upcoming: false, movingOn: null, usedBy: [] };
const BOX: BillingChoiceView = { id: "box", value: "PO Box 12, Bondi Junction", source: "billing", upcoming: false, movingOn: null, usedBy: ["Everyday spending"] };
const MOVING: BillingChoiceView = { id: "new", value: "9 New Road, Fremantle", source: "postal", upcoming: true, movingOn: "2027-03-01", usedBy: [] };

function render(props: Partial<React.ComponentProps<typeof BillingAddressChoice>> = {}): string {
  return renderToStaticMarkup(
    <BillingAddressChoice
      choices={[HOME, BOX, MOVING]}
      selectedKey=""
      newValue=""
      onSelect={() => {}}
      onNewValue={() => {}}
      {...props}
    />,
  );
}
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

test("each saved address is a choice with where it comes from, plus 'A different billing address'", () => {
  const markup = render();
  assert.match(markup, /<fieldset\b/);
  assert.match(markup, /<legend\b[^>]*>Billing address<\/legend>/);
  assert.equal((markup.match(/type="radio"/g) ?? []).length, 4);
  const t = text(markup);
  assert.match(t, /12 Banksia Street, Perth From About you/);
  assert.match(t, /PO Box 12, Bondi Junction Kept with your cards · used for Everyday spending/);
  assert.match(t, /9 New Road, Fremantle From About you · you're moving here on 1 Mar 2027/);
  assert.match(t, /A different billing address/);
  assert.ok(!/checked=""/.test(markup), "nothing is chosen for the person");
  assert.ok(!/<select\b/.test(markup), "no dropdown");
  assert.ok(!/street-address/.test(markup), "the address field waits until it's asked for");
});

test("'A different billing address' reveals a labelled address field kept with the cards", () => {
  const markup = render({ selectedKey: NEW_BILLING_KEY, newValue: "PO Box 1" });
  const input = markup.match(/<input[^>]*autoComplete="billing street-address"[^>]*>/)?.[0];
  assert.ok(input, "the address field shows");
  assert.match(input!, /maxLength="4096"/);
  assert.match(input!, /value="PO Box 1"/);
  const id = input!.match(/\bid="([^"]+)"/)![1]!;
  assert.match(markup, new RegExp(`<label[^>]*for="${id}"[^>]*>Different billing address</label>`), "the field has its own label");
  assert.match(text(markup), /Kept with your cards, not in About you/);
});

test("with nothing saved the address field shows straight away, with no choices", () => {
  const markup = render({ choices: [], selectedKey: NEW_BILLING_KEY });
  assert.ok(!/type="radio"/.test(markup));
  assert.ok(!/<fieldset\b/.test(markup));
  const input = markup.match(/<input[^>]*autoComplete="billing street-address"[^>]*>/)?.[0];
  assert.ok(input);
  const id = input!.match(/\bid="([^"]+)"/)![1]!;
  assert.match(markup, new RegExp(`<label[^>]*for="${id}"[^>]*>Billing address</label>`));
});

test("a problem with the choice is shown on it and marks it invalid", () => {
  const picking = render({ error: BILLING_CHOOSE_COPY });
  const describedBy = picking.match(/<fieldset[^>]*aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy, "the choice is described by the problem");
  assert.match(picking, /<fieldset[^>]*aria-invalid="true"/);
  assert.match(picking, new RegExp(`<p id="${describedBy}" role="alert"[^>]*>${BILLING_CHOOSE_COPY}</p>`));

  const typing = render({ selectedKey: NEW_BILLING_KEY, error: BILLING_TYPE_COPY });
  assert.match(typing, /<input[^>]*autoComplete="billing street-address"[^>]*aria-invalid="true"|<input[^>]*aria-invalid="true"[^>]*autoComplete="billing street-address"/);
  assert.equal((typing.match(new RegExp(BILLING_TYPE_COPY, "g")) ?? []).length, 1, "the problem shows once, on the field");
});

test("the choice becomes the selection the card actions take, or a plain-words problem", () => {
  const choices = [HOME, BOX, MOVING];
  assert.deepEqual(billingSelection(choiceKey(HOME), "", choices), { ok: true, selection: { source: "postal", id: "home" } });
  assert.deepEqual(billingSelection(choiceKey(BOX), "", choices), { ok: true, selection: { source: "billing", id: "box" } });
  assert.deepEqual(billingSelection(NEW_BILLING_KEY, "  PO Box 9  ", choices), { ok: true, selection: { source: "new", value: "PO Box 9" } });
  assert.deepEqual(billingSelection("", "", choices), { ok: false, error: BILLING_CHOOSE_COPY });
  assert.deepEqual(billingSelection("postal:gone", "", choices), { ok: false, error: BILLING_CHOOSE_COPY });
  assert.deepEqual(billingSelection(NEW_BILLING_KEY, "   ", choices), { ok: false, error: BILLING_TYPE_COPY });
  assert.deepEqual(billingSelection(NEW_BILLING_KEY, "x".repeat(4097), choices), { ok: false, error: BILLING_TOO_LONG_COPY });
  // With nothing saved, the typed address is the only way.
  assert.deepEqual(billingSelection("", "1 Home St", []), { ok: true, selection: { source: "new", value: "1 Home St" } });
});

test("a new card starts with nothing chosen (or the field, with nothing saved); a change starts on the card's address", () => {
  assert.equal(initialBillingKey([HOME, MOVING]), "");
  assert.equal(initialBillingKey([MOVING]), "", "an address the person is moving to is never the default");
  assert.equal(initialBillingKey([]), NEW_BILLING_KEY);
  assert.equal(initialBillingKey([HOME, BOX], { source: "billing", id: "box" }), choiceKey(BOX));
  assert.equal(initialBillingKey([HOME, BOX], { source: "postal", id: "gone" }), "");
  assert.equal(choiceSource({ id: "x", value: "y", source: "billing", usedBy: [] }), "Kept with your cards");
});
