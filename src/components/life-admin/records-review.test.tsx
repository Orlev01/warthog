// The Records tab: checking what agents found, and the typed forms (docs/adr/life-admin-profile.md).
//
// Agents fill Life admin in from email. What an agent saves arrives as a SUGGESTION the person
// confirms ("To check": Confirm, Not mine, or Edit — saving an edit confirms it), and an agent
// never overwrites a confirmed record: its change waits as a PENDING change the person accepts
// or declines ("<Agent> suggests a change", field: old → new; a change of kind first), one by one
// or all at once ("Accept all n changes"). Each row says who added it and
// where an agent says it found it. Adding takes two steps with no client JavaScript: a GET
// form picks the type, then that type's form shows every field by its kind. Editing shows
// every field of the type, keeps the record's other text details, and lists values an older
// agent saved as lists or objects read-only, so saving never flattens them.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { phased } from "./phase-fixture";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { declineConsequence, fillInPrompt } from "./records-view";
import { BUILT_IN, buildCatalogue, type CustomCategoryEntry } from "@/domain/life-admin/catalogue";
import type { CategoryStateView, SuggestedCategoryView } from "./record-view-types";

const CATEGORIES = BUILT_IN.categories;

const TODAY = "2026-11-23";
const noop = () => {};
const CHATGPT = { kind: "agent" as const, agentId: "agent-1", name: "ChatGPT" };

const REGO: LifeAdminRecordView = {
  id: "00000000-0000-4000-8000-00000000000a",
  kind: "item",
  type: "vehicles.registration",
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
  type: "banking.card",
  fields: { provider: "Westpac", last4: "4321", card_expiry: "2027-03" },
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
  type: "vehicles.vehicle",
  fields: { name: "Honda CB500X" },
  dueDate: null,
  status: "active",
  reminderOffsets: [],
};
const VAN: LifeAdminRecordView = { ...BIKE, id: "00000000-0000-4000-8000-00000000000e", fields: { name: "Toyota HiAce" } };
const PET: LifeAdminRecordView = { ...BIKE, id: "00000000-0000-4000-8000-00000000000f", type: "pets.pet", fields: { name: "Biscuit" } };

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminView
      today={TODAY}
      records={[REGO, CARD, HEALTH, BIKE, VAN, PET]}
      addRecordAction={noop}
      editRecordAction={noop}
      deleteRecordAction={noop}
      confirmRecordAction={noop}
      confirmAllAction={noop}
      dismissRecordAction={noop}
      acceptPendingAction={noop}
      acceptAllPendingAction={noop}
      declinePendingAction={noop}
      keepCategoryAction={noop}
      declineCategoryAction={noop}
      setCategoryVisibilityAction={noop}
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

// Each <form> with its posted hidden values (without where it returns to, `returnTab` /
// `returnCategory` / `returnStatus`, which `returns` holds), and its submit buttons' words.
function forms(markup: string): { body: string; hidden: [string, string][]; returns: [string, string][]; buttons: string[] }[] {
  return [...markup.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => {
    const values = [...m[1]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((h) => [h[1]!, h[2]!] as [string, string]);
    return {
      body: m[1]!,
      hidden: values.filter(([name]) => !name.startsWith("return")),
      returns: values.filter(([name]) => name.startsWith("return")),
      buttons: [...m[1]!.matchAll(/<button\b[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/g)].map((b) => text(b[1]!)),
    };
  });
}

// ─── To check ────────────────────────────────────────────────────────────────────────

test("To check appears only when there is something to check, first on the page", () => {
  const markup = render();
  assert.ok(panelOf(markup, "To check"), "shown with suggestions or a pending change");
  assert.ok(markup.indexOf(">To check</h2>") < markup.indexOf(">Vehicles</h2>"), "it comes first");
  assert.match(text(panelOf(markup, "To check")), /Your agents found these\. Agents are told they aren't checked yet until you confirm them/);
  const settled = render({ records: [{ ...HEALTH, pending: null }, BIKE] });
  assert.equal(panelOf(settled, "To check"), "", "nothing to check, no panel");
});

test("each suggestion shows its type and name, key facts, due line and where it was found, with Confirm, Not mine and Edit", () => {
  const item = itemOf(render(), `check-${REGO.id}`);
  const words = text(item);
  // A rego goes by its plate ("Registration · BX12AB"), so its type isn't repeated before it.
  assert.match(words, /^.*Registration · BX12AB Registration · Expires 14 Dec 2026/);
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

test("Accept all n changes posts every waiting change's id, and only appears with two or more", () => {
  const second: LifeAdminRecordView = { ...HEALTH, id: "00000000-0000-4000-8000-000000000011", fields: { provider: "Bupa" }, heldFields: undefined };
  const panel = panelOf(render({ records: [REGO, CARD, HEALTH, second] }), "To check");
  const all = forms(panel).find((form) => form.buttons.includes("Accept all 2 changes"));
  assert.ok(all, "Accept all 2 changes");
  assert.deepEqual(all!.hidden.map(([, value]) => value).sort(), [HEALTH.id, second.id].sort());
  assert.ok(forms(panel).some((form) => form.buttons.includes("Confirm all 2")), "beside Confirm all");
  assert.ok(!/Accept all/.test(text(panelOf(render(), "To check"))), "one change has no Accept all");
  assert.ok(!/Accept all/.test(text(panelOf(render({ records: [HEALTH, second], acceptAllPendingAction: undefined }), "To check"))), "no action, no button");
});

test("a change that gives a record another kind says so first, without the old schema's type and source lines", () => {
  const legacy: LifeAdminRecordView = {
    id: "00000000-0000-4000-8000-000000000012",
    kind: "renewal_appointment",
    fields: { what: "Honda CB500X", type: "vehicle", source: "gmail" },
    dueDate: null,
    status: "active",
    reminderOffsets: [],
    reviewState: "confirmed",
    pending: { byName: "ChatGPT", type: "vehicles.vehicle", set: { name: "Honda CB500X", plate: "BX12AB" }, remove: ["what", "type", "source"] },
  };
  const item = itemOf(render({ records: [legacy] }), `change-${legacy.id}`);
  const list = /<ul role="list" aria-label="Suggested changes"[^>]*>([\s\S]*?)<\/ul>/.exec(item)![1]!;
  const lines = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!));
  assert.deepEqual(lines, [
    "Kind: Renewal or appointment → changes to Vehicle (Vehicles)",
    "Nickname or make and model: not set → changes to Honda CB500X",
    "Number plate: not set → changes to BX12AB",
    "What: Honda CB500X → changes to removed",
  ]);
});

test("a change's link lands on the record's row when the filters show it, else on its page", () => {
  const shown = itemOf(render(), `change-${HEALTH.id}`);
  assert.match(shown, new RegExp(`href="#record-${HEALTH.id}"`));
  const hidden = itemOf(render({ recordFilter: { categories: ["vehicles"], statuses: ["active"] } }), `change-${HEALTH.id}`);
  assert.match(hidden, new RegExp(`href="/life-admin/items/${HEALTH.id}"`));
});

test("every record action returns to the filters it was submitted under", () => {
  const markup = render({ recordFilter: { categories: ["vehicles", "health"], statuses: ["active", "finished"] } });
  const posting = forms(markup).filter((form) => form.buttons.some((b) => /^(Confirm|Not mine|Accept change|Keep mine|Save reminder|Save changes|Delete record|Confirm all)/.test(b)));
  assert.ok(posting.length > 5);
  for (const form of posting) {
    assert.deepEqual(form.returns, [["returnTab", "records"], ["returnCategory", "vehicles"], ["returnCategory", "health"], ["returnStatus", "active"], ["returnStatus", "finished"]], form.buttons.join());
  }
  // "Not for me" is on the Add tab (founder, 24 Nov 2026), and comes back there.
  const notForMe = forms(markup).filter((form) => form.buttons.some((b) => /^Not for me/.test(b)));
  assert.ok(notForMe.length > 0);
  for (const form of notForMe) assert.deepEqual(form.returns, [["returnTab", "add"]], form.buttons.join());
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

test("Fill in the rest offers at most six empty categories by priority, each with Not for me only, a prompt to copy that works across services, and says Warthog doesn't read anything itself", () => {
  const panel = panelOf(render(), "Fill in the rest");
  const words = text(panel);
  const offered = [...panel.matchAll(/<p class="text-sm font-medium text-fg">([^<]+)<\/p>/g)].map((m) => m[1]!.replace(/&amp;/g, "&")).filter((label) => label !== "Ask your agent");
  assert.deepEqual(offered, ["Super and investing", "Home", "Utilities", "ID and residency", "Trips and travel", "Tax and government"], "lowest priority first, never those with records or Other");
  const posted = forms(panel);
  const home = posted.filter((form) => form.hidden.some(([name, value]) => name === "category" && value === "home"));
  assert.deepEqual(home.map((form) => [form.hidden, form.buttons]), [
    [[["category", "home"], ["setting", "not_for_me"]], ["Not for me : Home"]],
  ], "no Show: an empty category never has a panel, so showing one would do nothing");
  assert.doesNotMatch(words, /\bShow\b/);
  assert.match(words, /Please look through what you can read in Warthog for my super fund and investments, lease or mortgage, home insurance and rates, electricity, gas, internet and phone accounts, passport, licence and visa expiry dates, flights, hotels and trips and tax, fines and government payments, and save what you find to my Life admin for me to check\. Read Warthog's "Life admin records" skill first\./);
  assert.match(words, /Copy prompt for your agent/);
  assert.match(words, /Your agent can find these in your email, calendar and files\./);
  assert.match(words, /Warthog doesn't read your things itself\. Your agent does, through Warthog, and only what you allow it to\./);
  assert.doesNotMatch(words, /Build your profile/, "with records on file, no link to the whole build");
  assert.equal(
    fillInPrompt(CATEGORIES.filter((category) => ["vehicles", "health"].includes(category.id))),
    "Please look through what you can read in Warthog for my rego and car insurance and health insurance and appointments, and save what you find to my Life admin for me to check. Read Warthog's \"Life admin records\" skill first.",
  );
  assert.match(text(panelOf(render({ records: [] }), "Fill in your life admin")), /Vehicles/, "with nothing yet, the first six are offered");
});

test("an empty category the person once chose to show is offered too, as production's every-category-shown accounts have", () => {
  const states: CategoryStateView[] = CATEGORIES.map((category) => ({ id: category.id, visibility: "shown", records: category.id === "investing" ? 2 : 0 }));
  const offered = [...panelOf(render({ records: [], categories: states }), "Fill in your life admin").matchAll(/<p class="text-sm font-medium text-fg">([^<]+)<\/p>/g)].map((m) => m[1]!.replace(/&amp;/g, "&")).filter((label) => label !== "Ask your agent");
  assert.deepEqual(offered, ["Vehicles", "Health", "Home", "Utilities", "ID and residency", "Trips and travel"], "a category with records isn't");
});

test("Not for me (n) lists the hidden categories, with how many records they keep, and Undo", () => {
  const states: CategoryStateView[] = CATEGORIES.map((category) => ({
    id: category.id,
    visibility: category.id === "pets" || category.id === "legal" ? "not_for_me" : "available",
    records: category.id === "pets" ? 1 : 0,
  }));
  const panel = panelOf(render({ records: [], categories: states }), "Fill in your life admin");
  assert.match(text(panel), /Not for me \(2\) Legal and estate Undo : show Legal and estate again Pets · 1 record kept, hidden on every tab Undo : show Pets again/);
  const undo = forms(panel).filter((form) => form.buttons.some((b) => /^Undo/.test(b)));
  assert.deepEqual(undo.map((form) => form.hidden), [[["category", "legal"], ["setting", "clear"]], [["category", "pets"], ["setting", "clear"]]]);
});

// ─── suggested categories of the person's own ────────────────────────────────────────

const ROWING: CustomCategoryEntry = {
  slug: "x_7kq2mz",
  state: "suggested",
  suggestedByAgentId: "agent-1",
  definition: {
    label: "Rowing club",
    description: "Your rowing club membership, regattas and boat storage.",
    lifeArea: "everyday",
    icon: "trophy",
    why: "Three emails from Sydney Rowing Club about fees and regattas.",
    kinds: [
      { key: "membership", label: "Club membership", lifecycle: "standing", use: "The club membership.", fields: [{ key: "boat_rack", label: "Boat rack", kind: "text" }], due: { means: "renews", label: "Renews" } },
      { key: "regatta", label: "Regatta", lifecycle: "booking", use: "A regatta entry.", fields: [] },
    ],
  },
};
const ROWING_VIEW: SuggestedCategoryView = {
  slug: "x_7kq2mz",
  label: "Rowing club",
  description: "Your rowing club membership, regattas and boat storage.",
  suggestedBy: "ChatGPT",
  why: "Three emails from Sydney Rowing Club about fees and regattas.",
  kinds: ["Club membership", "Regatta"],
  records: 2,
  suggestedRecords: 1,
  confirmedRecords: 1,
};

test("a suggested category of the person's own waits under To check with the agent's reason, its kinds and records, Keep and Decline", () => {
  const catalogue = buildCatalogue([ROWING]);
  const membership: LifeAdminRecordView = { id: "00000000-0000-4000-8000-000000000020", kind: "item", type: "x_7kq2mz.membership", fields: { provider: "Sydney Rowing Club", boat_rack: "B12" }, dueDate: "2027-07-01", status: "active", reminderOffsets: [], reviewState: "suggested", addedBy: CHATGPT };
  const markup = render({ records: [membership], catalogue: catalogue.data, suggestedCategories: [ROWING_VIEW] });
  const item = itemOf(markup, "suggested-category-x_7kq2mz");
  const words = text(item);
  assert.match(words, /^.*Rowing club Suggested category Your rowing club membership, regattas and boat storage\./);
  assert.match(words, /Suggested by ChatGPT: Three emails from Sydney Rowing Club about fees and regattas\./);
  assert.match(words, /Adds Club membership and Regatta Holds 2 records, 1 not checked yet/);
  const posted = forms(item);
  const keep = posted.find((form) => form.buttons.some((b) => /^Keep\b/.test(b)))!;
  assert.deepEqual(keep.hidden, [["slug", "x_7kq2mz"]]);
  assert.match(keep.body, /wh-button[^"]*bg-accent/, "Keep is the primary action");
  const decline = posted.find((form) => form.buttons.some((b) => /^Decline category/.test(b)))!;
  assert.deepEqual(decline.hidden, [["slug", "x_7kq2mz"]]);
  assert.match(words, /Decline \u201cRowing club\u201d\? Its 1 suggested record will be removed and the 1 record you confirmed will move to Something else, with their details kept\. Agents won't suggest it again\./);
  // Its records already show, in a panel of their own marked Suggested, with the kind's own fields.
  const panel = markup.slice(markup.search(/<h2\b[^>]*><span[^>]*>Rowing club/));
  assert.match(text(panel), /^Rowing club Suggested Sydney Rowing Club Current Not checked yet Club membership · Renews 1 Jul\w* 2027/);
  assert.match(text(panel), /Boat rack B12/);
  assert.match(panel, /<optgroup label="Rowing club"><option value="x_7kq2mz.membership">Club membership<\/option><option value="x_7kq2mz.regatta">Regatta<\/option>/, "its kinds can be added");
});

test("declining copy says what happens to each kind of record", () => {
  assert.equal(declineConsequence({ label: "Boat", suggestedRecords: 3, confirmedRecords: 0 }), "Decline \u201cBoat\u201d? Its 3 suggested records will be removed. Agents won't suggest it again.");
  assert.equal(declineConsequence({ label: "Boat", suggestedRecords: 0, confirmedRecords: 0 }), "Decline \u201cBoat\u201d? It has no records yet. Agents won't suggest it again.");
});

// ─── adding ──────────────────────────────────────────────────────────────────────────

test("step one: a GET form picks the type from a list grouped by category", () => {
  const markup = render({ records: [] });
  const form = /<form\b([^>]*method="get"[^>]*)>([\s\S]*?)<\/form>/.exec(markup)!;
  assert.ok(form, "a plain GET form, so it works without JavaScript");
  assert.match(form[1]!, /action="\/life-admin#new-record"/);
  assert.match(form[2]!, /<input type="hidden" name="tab" value="add"\/>/, "the chosen kind's form opens on the Add tab");
  assert.match(form[2]!, /<select\b[^>]*name="add"/);
  const groups = [...form[2]!.matchAll(/<optgroup label="([^"]+)">/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  assert.deepEqual(groups, CATEGORIES.map((category) => category.label), "every category of the catalogue, in its order");
  assert.match(form[2]!, /<optgroup label="Vehicles"><option value="vehicles.vehicle">Vehicle<\/option><option value="vehicles.registration">Registration<\/option>/);
  assert.doesNotMatch(markup, /name="type"/, "no type's form until one is chosen");
});

test("step two: the chosen type's form has every field by kind, the due date in the type's words, status and Belongs to", () => {
  const markup = render({ addType: "vehicles.registration" });
  const form = forms(markup).find((f) => f.buttons.includes("Add to Life admin"))!;
  assert.ok(form, "the add form");
  assert.deepEqual(form.hidden.filter(([name]) => name === "type"), [["type", "vehicles.registration"]]);
  const names = [...form.body.matchAll(/name="(field:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["field:name", "field:provider", "field:account_name", "field:reference", "field:account_email", "field:plate", "field:state", "field:term", "field:ctp_insurer", "field:inspection", "field:amount", "field:currency", "field:cycle", "field:for_whom", "field:contact", "field:email", "field:website", "field:notes"]);
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
  const vehicle = forms(render({ addType: "vehicles.vehicle" })).find((f) => f.buttons.includes("Add to Life admin"))!;
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
  assert.deepEqual(names, ["name", "provider", "account_name", "reference", "account_email", "hospital_cover", "extras_cover", "excess", "scale", "ambulance", "amount", "currency", "cycle", "for_whom", "contact", "email", "website", "notes", "colour"]);
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
  const odd: LifeAdminRecordView = { ...HEALTH, id: "00000000-0000-4000-8000-000000000010", type: "belongings.receipt", kind: "receipt_warranty", fields: { item: "Kettle", purchased_on: "last spring" }, heldFields: undefined, pending: null };
  const edit = forms(render({ records: [odd] })).find((f) => f.buttons.includes("Save changes") && /name="field:/.test(f.body))!;
  const input = /<input\b[^>]*name="field:purchased_on"[^>]*>/.exec(edit.body)![0];
  assert.doesNotMatch(input, /type="date"/);
  assert.match(input, /value="last spring"/);
});

// ─── the new field kinds and lifecycles in the forms ─────────────────────────────────

test("a booking's form: date-times with their time zone, a number with its unit, yes/no, no separate due date, booking statuses", () => {
  const form = forms(render({ addType: "outings.restaurant", zone: "Australia/Sydney" })).find((f) => f.buttons.includes("Add to Life admin"))!;
  assert.match(form.body, /<input[^>]*type="datetime-local"[^>]*name="field:starts_at"|name="field:starts_at"[^>]*type="datetime-local"/);
  const zone = /<select[^>]*name="zone:starts_at"[^>]*>([\s\S]*?)<\/select>/.exec(form.body)!;
  assert.ok(zone, "a time-zone choice beside it");
  assert.match(zone[0], /<option value="Australia\/Sydney" selected="">Sydney \(Australia\)<\/option>/, "the person's zone first, chosen");
  assert.match(zone[1]!, /value="Asia\/Tokyo"/);
  assert.match(text(form.body), /Time zone for Starts/, "each zone is named for its field");
  assert.match(form.body, /name="field:party_size"[^>]*inputMode="decimal"|inputMode="decimal"[^>]*name="field:party_size"/);
  assert.match(text(form.body), /How many people/, "the unit sits beside the number");
  const held = /<select[^>]*name="field:card_held"[^>]*>([\s\S]*?)<\/select>/.exec(form.body)!;
  assert.deepEqual([...held[1]!.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]), [["", "Not set"], ["yes", "Yes"], ["no", "No"]]);
  assert.match(form.body, /<input[^>]*type="email"[^>]*name="field:email"|name="field:email"[^>]*type="email"/);
  assert.match(text(form.body), /For Leave empty when it's yours\. A first name or relationship only\./);
  assert.doesNotMatch(form.body, /name="dueDate"/, "its start sets the date");
  assert.deepEqual([...form.body.matchAll(/<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/g)].flatMap((m) => [...m[1]!.matchAll(/value="([^"]+)"/g)].map((v) => v[1])), ["confirmed", "pending", "cancelled", "no_show"]);
});

test("a card's expiry is a month picker; a case offers open, waiting and resolved", () => {
  const card = forms(render({ addType: "banking.card" })).find((f) => f.buttons.includes("Add to Life admin"))!;
  assert.match(card.body, /type="month"[^>]*name="field:card_expiry"|name="field:card_expiry"[^>]*type="month"/);
  const fine = forms(render({ addType: "government.fine" })).find((f) => f.buttons.includes("Add to Life admin"))!;
  assert.deepEqual([...fine.body.matchAll(/<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/g)].flatMap((m) => [...m[1]!.matchAll(/value="([^"]+)"/g)].map((v) => v[1])), ["open", "waiting", "resolved"]);
  assert.match(text(fine.body), /Pay by \(optional\)/);
});

test("editing a date-time shows its own wall time and zone, and a booking's own state", () => {
  const dinner: LifeAdminRecordView = {
    id: "00000000-0000-4000-8000-000000000030",
    kind: "item",
    type: "outings.restaurant",
    fields: { provider: "Sixpenny", starts_at: "2026-12-03T19:30+09:00[Asia/Tokyo]", cancel_by: "2026-12-01" },
    dueDate: "2026-12-03",
    status: "active",
    state: "pending",
    reminderOffsets: [1, 0],
  };
  // Its phase worked out as the loader does: a live booking, managed from Upcoming.
  const edit = forms(render({ records: [phased(dinner)], zone: "Australia/Sydney" })).find((f) => f.buttons.includes("Save changes") && /name="field:/.test(f.body))!;
  assert.match(edit.body, /name="field:starts_at"[^>]*value="2026-12-03T19:30"|value="2026-12-03T19:30"[^>]*name="field:starts_at"/);
  assert.match(/<select[^>]*name="zone:starts_at"[^>]*>[\s\S]*?<\/select>/.exec(edit.body)![0], /<option value="Asia\/Tokyo" selected="">/);
  assert.match(edit.body, /<input type="hidden" name="dateonly:cancel_by" value="2026-12-01"\/>/, "a date alone is kept a date unless a time is added");
  assert.match(/<select[^>]*name="status"[^>]*>[\s\S]*?<\/select>/.exec(edit.body)![0], /<option value="pending" selected="">Waiting to be confirmed<\/option>/);
});

test("Belongs to offers only the anchors this kind may belong to, by the catalogue's rule", () => {
  const trip: LifeAdminRecordView = { ...BIKE, id: "00000000-0000-4000-8000-000000000040", type: "travel.trip", fields: { name: "Tokyo" } };
  const flight = forms(render({ records: [BIKE, PET, trip], addType: "travel.flight" })).find((f) => f.buttons.includes("Add to Life admin"))!;
  const options = [...(/<select[^>]*name="parentId"[^>]*>([\s\S]*?)<\/select>/.exec(flight.body)![1]!).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => m[2]);
  assert.deepEqual(options, ["Not linked", "Honda CB500X (Vehicle)", "Biscuit (Pet)", "Tokyo (Trip)"], "a booking may belong to any anchor");
  const petInsurance = forms(render({ records: [BIKE, PET, trip], addType: "pets.insurance" })).find((f) => f.buttons.includes("Add to Life admin"))!;
  const petOptions = [...(/<select[^>]*name="parentId"[^>]*>([\s\S]*?)<\/select>/.exec(petInsurance.body)![1]!).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => m[2]);
  assert.deepEqual(petOptions, ["Not linked", "Biscuit"]);
});

test("Cancel on a kind's form stays on the Add tab", () => {
  const markup = render({ addType: "vehicles.registration" });
  assert.match(markup, /href="\/life-admin\?tab=add#new-record"[^>]*>Cancel/);
});

// docs/adr/profile-build.md: a profile build can leave many suggestions; across categories they're
// grouped, each with its count and its own "Confirm all".
test("suggestions across categories are grouped, each with its count and its own Confirm all", () => {
  const VAN_REGO: LifeAdminRecordView = { ...REGO, id: "00000000-0000-4000-8000-0000000000aa", fields: { plate: "VAN123" } };
  const markup = render({ records: [REGO, VAN_REGO, CARD, HEALTH, BIKE] });
  const found = markup.slice(markup.indexOf('id="to-check-suggestions-heading"'));
  assert.match(text(found), /Vehicles · 2/);
  assert.match(text(found), /Banking and credit · 1/);
  assert.match(text(found), /Confirm all 2 in Vehicles/);
  assert.doesNotMatch(text(found), /Confirm all 1 in/, "no Confirm all for a single suggestion");
  assert.match(found, /<details open=""/, "the first group is open");
  assert.match(text(markup), /Confirm all 3/, "the panel's Confirm all stays");
  const single = render({ records: [REGO, BIKE] });
  assert.doesNotMatch(text(single), /Vehicles · 1/, "one category: no grouping");
});


// docs/adr/profile-build.md: the Add tab is the permanent home of "Build your whole profile", where
// Home's set-up row leads once the step is done (the prompt can be run again any time).
test("the Add tab has Build your whole profile, first, with the prompt to copy for the agent that can do it", () => {
  const markup = render({ profileBuild: { state: "ready", agentName: "Claude", sources: ["Gmail", "Google Drive"] } });
  const panel = panelOf(markup, "Build your whole profile");
  assert.match(panel, /id="build-profile"/);
  assert.match(text(panel), /Claude can read: Gmail and Google Drive\./);
  assert.match(panel, /Copy for Claude/);
  assert.match(text(panel), /Run it again any time: it fills the gaps\./);
  const add = markup.slice(markup.indexOf("Build your whole profile"));
  assert.ok(add.indexOf("Build your whole profile") < add.indexOf("Add something yourself"), "first on Add");
  assert.equal(panelOf(render({}), "Build your whole profile"), "", "only when the page passes who can build it");
});
