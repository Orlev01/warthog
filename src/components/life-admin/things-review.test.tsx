// "Your things": checking what agents found, and the typed forms (docs/adr/life-admin-profile.md).
//
// Agents fill Life admin in from email. What an agent saves arrives as a SUGGESTION the person
// confirms ("To check": Confirm, Not mine, or Edit — saving an edit confirms it), and an agent
// never overwrites a confirmed record: its change waits as a PENDING change the person accepts
// or declines ("<Agent> suggests a change", field: old → new). Each row says who added it and
// where an agent says it found it. Adding takes two steps with no client JavaScript: a GET
// form picks the type, then that type's form shows every field by its kind. Editing shows
// every field of the type, keeps the record's other text details, and lists values an older
// agent saved as lists or objects read-only, so saving never flattens them.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { fillInPrompt } from "./things-view";
import { CATEGORIES } from "@/domain/life-admin/record-types";

const TODAY = "2026-11-23";
const noop = () => {};
const CHATGPT = { kind: "agent" as const, agentId: "agent-1", name: "ChatGPT" };

const REGO: LifeAdminRecordView = {
  id: "00000000-0000-4000-8000-00000000000a",
  kind: "item",
  type: "vehicle.registration",
  fields: { plate: "BX12AB", provider: "Transport for NSW", amount: "412.50", currency: "AUD", cycle: "yearly" },
  dueDate: "2026-12-14",
  status: "active",
  reminderOffsets: [30, 7],
  reviewState: "suggested",
  addedBy: CHATGPT,
  foundIn: { service: "google-gmail", sender: "service.nsw.gov.au", date: "2026-10-02", seenByWarthog: true },
};
const CARD: LifeAdminRecordView = {
  id: "00000000-0000-4000-8000-00000000000b",
  kind: "item",
  type: "money.credit_card",
  fields: { provider: "Westpac", last4: "4321" },
  dueDate: null,
  status: "active",
  reminderOffsets: [],
  reviewState: "suggested",
  addedBy: CHATGPT,
};
const HEALTH: LifeAdminRecordView = {
  id: "00000000-0000-4000-8000-00000000000c",
  kind: "item",
  type: "health.insurance",
  fields: { provider: "Medibank", notes: "Old note", colour: "blue" },
  heldFields: { extras_used: "Dental: 120; Optical: …" },
  dueDate: "2027-03-01",
  status: "active",
  reminderOffsets: [45],
  reviewState: "confirmed",
  addedBy: { kind: "person" },
  pending: { byName: "Claude", set: { hospital_cover: "gold" }, remove: ["notes"], dueDate: "2028-03-01", foundIn: { service: "google-gmail", sender: "medibank.com.au", seenByWarthog: false } },
};
const BIKE: LifeAdminRecordView = {
  id: "00000000-0000-4000-8000-00000000000d",
  kind: "item",
  type: "vehicle.vehicle",
  fields: { name: "Honda CB500X" },
  dueDate: null,
  status: "active",
  reminderOffsets: [],
};
const VAN: LifeAdminRecordView = { ...BIKE, id: "00000000-0000-4000-8000-00000000000e", fields: { name: "Toyota HiAce" } };
const PET: LifeAdminRecordView = { ...BIKE, id: "00000000-0000-4000-8000-00000000000f", type: "pet.pet", fields: { name: "Biscuit" } };

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminView
      today={TODAY}
      records={[REGO, CARD, HEALTH, BIKE, VAN, PET]}
      checklist={[]}
      addRecordAction={noop}
      editRecordAction={noop}
      deleteRecordAction={noop}
      confirmRecordAction={noop}
      confirmAllAction={noop}
      dismissRecordAction={noop}
      acceptPendingAction={noop}
      declinePendingAction={noop}
      {...over}
    />,
  );
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function panelOf(markup: string, title: string): string {
  const at = markup.search(new RegExp(`<h2\\b[^>]*>${title}</h2>`));
  if (at < 0) return "";
  const start = markup.lastIndexOf("<section", at);
  const next = markup.slice(at).search(/<section aria-labelledby="[^"]*" class="wh-panel[ "]/);
  return markup.slice(start, next < 0 ? undefined : at + next);
}

function itemOf(markup: string, id: string): string {
  const start = markup.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `${id} renders`);
  const end = markup.indexOf('<li id="', start + 1);
  return markup.slice(start, end < 0 ? undefined : end);
}

// Each <form> with its posted hidden values and its submit buttons' words.
function forms(markup: string): { body: string; hidden: [string, string][]; buttons: string[] }[] {
  return [...markup.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => ({
    body: m[1]!,
    hidden: [...m[1]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((h) => [h[1]!, h[2]!]),
    buttons: [...m[1]!.matchAll(/<button\b[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/g)].map((b) => text(b[1]!)),
  }));
}

// ─── To check ────────────────────────────────────────────────────────────────────────

test("To check appears only when there is something to check, first on the page", () => {
  const markup = render();
  assert.ok(panelOf(markup, "To check"), "shown with suggestions or a pending change");
  assert.ok(markup.indexOf(">To check</h2>") < markup.indexOf(">Coming up</h2>"), "it comes first");
  assert.match(text(panelOf(markup, "To check")), /Your agents found these\. Agents are told they aren't checked yet until you confirm them/);
  const settled = render({ records: [{ ...HEALTH, pending: null }, BIKE] });
  assert.equal(panelOf(settled, "To check"), "", "nothing to check, no panel");
});

test("each suggestion shows its type and name, key facts, due line and where it was found, with Confirm, Not mine and Edit", () => {
  const item = itemOf(render(), `check-${REGO.id}`);
  const words = text(item);
  // A rego goes by its plate ("Registration · BX12AB"), so its type isn't repeated before it.
  assert.match(words, /^.*Registration · BX12AB Registration · Expires 14 Dec 2026 · Active/);
  assert.ok(!/Registration: Registration/.test(words));
  assert.match(words, /Renewal cost AUD 412\.50 a year/);
  assert.match(words, /Found by ChatGPT in an email from service\.nsw\.gov\.au \(2 Oct 2026\)\. ChatGPT read it through Warthog\./);
  const posted = forms(item);
  const confirm = posted.find((form) => form.buttons.some((b) => /^Confirm\b/.test(b)))!;
  assert.deepEqual(confirm.hidden, [["recordId", REGO.id]]);
  assert.match(confirm.body, /wh-button[^"]*bg-accent/, "Confirm is the primary action");
  const dismiss = posted.find((form) => form.buttons.some((b) => /^Not mine\b/.test(b)))!;
  assert.deepEqual(dismiss.hidden, [["recordId", REGO.id]]);
  const edit = posted.find((form) => form.buttons.includes("Save and confirm"));
  assert.ok(edit, "the Edit disclosure's form saves and confirms");
  assert.ok(edit!.hidden.some(([name, value]) => name === "recordId" && value === REGO.id));
});

test("Confirm all posts every suggestion's id, and only appears with two or more", () => {
  const panel = panelOf(render(), "To check");
  const all = forms(panel).find((form) => form.buttons.includes("Confirm all 2"));
  assert.ok(all, "Confirm all 2");
  assert.deepEqual(all!.hidden.map(([, value]) => value).sort(), [REGO.id, CARD.id].sort());
  assert.ok(!/Confirm all/.test(text(panelOf(render({ records: [REGO] }), "To check"))), "one suggestion has no Confirm all");
});

test("a pending change reads as '<Agent> suggests a change' with labelled old → new lines, Accept change and Keep mine", () => {
  const item = itemOf(render(), `change-${HEALTH.id}`);
  const words = text(item);
  assert.match(words, /^.*Claude suggests a change Health insurance · Medibank/);
  assert.match(words, /Hospital cover: not set → changes to gold/);
  assert.match(words, /Notes: Old note → changes to removed/);
  assert.match(words, /Renews or extras reset: 1 Mar 2027 → changes to 1 Mar 2028/);
  assert.match(words, /Claude says it found this in an email from medibank\.com\.au\./);
  const posted = forms(item);
  assert.deepEqual(posted.find((form) => form.buttons.some((b) => /^Accept change/.test(b)))!.hidden, [["recordId", HEALTH.id]]);
  assert.deepEqual(posted.find((form) => form.buttons.some((b) => /^Keep mine/.test(b)))!.hidden, [["recordId", HEALTH.id]]);
});

test("in its category, a suggestion is tagged Not checked yet and a pending change is flagged, in words and an icon", () => {
  const markup = render();
  const rego = markup.slice(markup.indexOf(`id="record-${REGO.id}"`), markup.indexOf(`id="record-${REGO.id}"`) + 3000);
  assert.match(rego, /<svg[^>]*>[\s\S]*?<\/svg>Not checked yet/, "the tag has an icon and words");
  const health = markup.slice(markup.indexOf(`id="record-${HEALTH.id}"`), markup.indexOf(`id="record-${HEALTH.id}"`) + 3000);
  assert.match(text(health), /Change suggested/);
  assert.doesNotMatch(text(health), /Not checked yet/, "the person's own record is checked");
});

test("without the review actions, Confirm and Accept change are disabled and say why", () => {
  const markup = render({ confirmRecordAction: undefined, acceptPendingAction: undefined });
  assert.match(text(markup), /Confirming isn't available just now\./);
  assert.match(text(markup), /Accepting changes isn't available just now\./);
});

// ─── Fill in the rest ────────────────────────────────────────────────────────────────

test("Fill in the rest lists the empty categories with a prompt to copy and says Warthog doesn't read email itself", () => {
  const panel = panelOf(render(), "Fill in the rest");
  const words = text(panel);
  assert.match(words, /Home Where you live/);
  assert.doesNotMatch(words, /Vehicles Cars, motorcycles/, "a category with records isn't listed");
  assert.doesNotMatch(words, /Other Renewals, appointments/, "Other has nothing specific to look for");
  assert.match(words, /Use Warthog to look through my email for my home, bills, insurance, ID expiry dates, work, subscriptions and receipts, and save what you find to my Life admin for me to check\./);
  assert.match(words, /Copy prompt for your agent/);
  assert.match(words, /Warthog doesn't read your email itself\. Your agent does, through Warthog, and only what you allow it to\./);
  assert.equal(
    fillInPrompt(CATEGORIES.filter((category) => ["vehicle", "health", "money", "utility"].includes(category.id))),
    "Use Warthog to look through my email for my vehicles, bills, health insurance and super, and save what you find to my Life admin for me to check.",
  );
  assert.match(text(panelOf(render({ records: [] }), "Fill in your life admin")), /Vehicles/, "with nothing yet, every category is listed");
});

// ─── adding ──────────────────────────────────────────────────────────────────────────

test("step one: a GET form picks the type from a list grouped by category", () => {
  const markup = render({ records: [] });
  const form = /<form\b([^>]*method="get"[^>]*)>([\s\S]*?)<\/form>/.exec(markup)!;
  assert.ok(form, "a plain GET form, so it works without JavaScript");
  assert.match(form[1]!, /action="\/life-admin#new-record"/);
  assert.match(form[2]!, /<input type="hidden" name="view" value="life"\/>/);
  assert.match(form[2]!, /<input type="hidden" name="tab" value="things"\/>/);
  assert.match(form[2]!, /<select\b[^>]*name="add"/);
  const groups = [...form[2]!.matchAll(/<optgroup label="([^"]+)">/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  assert.deepEqual(groups, CATEGORIES.map((category) => category.label));
  assert.match(form[2]!, /<optgroup label="Vehicles"><option value="vehicle.vehicle">Vehicle<\/option><option value="vehicle.registration">Registration<\/option>/);
  assert.doesNotMatch(markup, /name="type"/, "no type's form until one is chosen");
});

test("step two: the chosen type's form has every field by kind, the due date in the type's words, status and Belongs to", () => {
  const markup = render({ addType: "vehicle.registration" });
  const form = forms(markup).find((f) => f.buttons.includes("Add to Life admin"))!;
  assert.ok(form, "the add form");
  assert.deepEqual(form.hidden.filter(([name]) => name === "type"), [["type", "vehicle.registration"]]);
  const names = [...form.body.matchAll(/name="(field:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["field:plate", "field:state", "field:provider", "field:reference", "field:amount", "field:currency", "field:cycle", "field:term", "field:ctp_insurer", "field:inspection", "field:notes"]);
  assert.match(form.body, /inputMode="decimal"[^>]*name="field:amount"|name="field:amount"[^>]*inputMode="decimal"/, "amounts get a decimal keypad");
  assert.match(form.body, /<datalist id="[^"]+"><option value="NSW"><\/option>/, "the state's usual values are suggested");
  assert.match(form.body, /<textarea[^>]*name="field:notes"/, "notes are a text area");
  assert.match(text(form.body), /Expires \(optional\)/, "the due date is labelled the type's way");
  assert.match(form.body, /type="date"[^>]*name="dueDate"/);
  assert.deepEqual([...form.body.matchAll(/<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/g)].flatMap((m) => [...m[1]!.matchAll(/value="([^"]+)"/g)].map((v) => v[1])), ["active", "paused", "cancelled", "expired", "done"]);
  const parents = /<select[^>]*name="parentId"[^>]*>([\s\S]*?)<\/select>/.exec(form.body)!;
  assert.deepEqual([...parents[1]!.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]), [
    ["", "Not linked"],
    [BIKE.id, "Honda CB500X"],
    [VAN.id, "Toyota HiAce"],
  ], "only vehicles, never the pet");
});

test("a type with no due date has no due date field, and Belongs to is left out when there is nothing to belong to", () => {
  const vehicle = forms(render({ addType: "vehicle.vehicle" })).find((f) => f.buttons.includes("Add to Life admin"))!;
  assert.doesNotMatch(vehicle.body, /name="dueDate"/);
  assert.doesNotMatch(vehicle.body, /name="parentId"/, "a vehicle belongs to nothing");
  const lease = forms(render({ addType: "home.lease" })).find((f) => f.buttons.includes("Add to Life admin"))!;
  assert.match(text(lease.body), /Lease ends \(optional\)/);
  assert.doesNotMatch(lease.body, /name="parentId"/, "no home saved yet");
  const passport = render({ addType: "id.passport" });
  assert.match(text(passport), /Keep the number itself in your Vault/, "ID documents say where the number belongs");
});

// ─── editing ─────────────────────────────────────────────────────────────────────────

test("Edit shows every field of the type, empty ones too, and the record's own other details", () => {
  const markup = render({ records: [HEALTH] });
  const edit = forms(markup).find((f) => f.buttons.includes("Save changes") && /name="field:/.test(f.body))!;
  const names = [...edit.body.matchAll(/name="field:([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["provider", "reference", "hospital_cover", "extras_cover", "excess", "scale", "amount", "currency", "cycle", "ambulance", "contact", "notes", "colour"]);
  assert.match(edit.body, /name="field:provider"[^>]*value="Medibank"|value="Medibank"[^>]*name="field:provider"/);
  assert.match(edit.body, /name="field:colour"[^>]*value="blue"|value="blue"[^>]*name="field:colour"/, "an agent's own detail stays editable");
});

test("a value an older agent saved as a list or object is shown read-only, kept out of the form, never [object Object]", () => {
  const markup = render({ records: [HEALTH] });
  const edit = forms(markup).find((f) => f.buttons.includes("Save changes") && /name="field:/.test(f.body))!;
  assert.doesNotMatch(edit.body, /name="field:extras_used"/, "not an input, so saving keeps it as it is");
  assert.match(text(edit.body), /Also saved .* Extras used Dental: 120; Optical: …/);
  assert.doesNotMatch(markup, /\[object Object\]/);
});

test("a stored date-kind value that isn't a calendar date stays a text field, so saving never blanks it", () => {
  const odd: LifeAdminRecordView = { ...HEALTH, id: "00000000-0000-4000-8000-000000000010", type: "purchase.receipt", kind: "receipt_warranty", fields: { item: "Kettle", purchased_on: "last spring" }, heldFields: undefined, pending: null };
  const edit = forms(render({ records: [odd] })).find((f) => f.buttons.includes("Save changes") && /name="field:/.test(f.body))!;
  const input = /<input\b[^>]*name="field:purchased_on"[^>]*>/.exec(edit.body)![0];
  assert.doesNotMatch(input, /type="date"/);
  assert.match(input, /value="last spring"/);
});
