// About you suggestions, as the person sees them (src/components/vault/identity-suggestions.tsx,
// rendered by IdentityView; docs/adr/profile-build.md).
//
// When an agent has suggested details, About you shows a "Suggested by your agents" panel above
// the everyday details: one row per suggestion with the kind, the value (an address with the date
// they're moving there), where the agent says it found it in plain words, and whether it differs
// from the detail of that kind they already have. Each row has its own Add and Not mine, plain
// forms that post the suggestion's id (so they work before the page's JavaScript loads), with
// names that say what they add. There is no "Add all": each one is confirmed on its own. With
// nothing suggested, the panel isn't there.
//
// Rendered with react-dom/server, as the sibling view tests are.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { IdentitySuggestions, suggestionSourceLine, type IdentitySuggestionView } from "./identity-suggestions";
import { IdentityView } from "./identity-view";

const noop = async () => {};

const PHONE: IdentitySuggestionView = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "phone",
  value: "0412 345 678",
  movingOn: null,
  source: { service: "google-gmail", date: "2026-10-03", sender: "AGL Energy <bills@agl.com.au>" },
  agentName: "Claude",
  differsFrom: true,
};
const ADDRESS: IdentitySuggestionView = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "postal_address",
  value: "Unit 4, 1234567890123456789012345678901234567890 Example Street, Bondi NSW 2026",
  movingOn: "2027-01-15",
  source: { service: "google-calendar", date: "2026-11-01" },
  agentName: "ChatGPT",
};
const NAME: IdentitySuggestionView = {
  id: "00000000-0000-4000-8000-000000000003",
  kind: "preferred_name",
  value: "Phil",
  movingOn: null,
  source: { service: "microsoft-onedrive" },
  agentName: "An agent",
};

function visibleText(markup: string): string {
  return markup
    .replace(/<span class="sr-only">[^<]*<\/span>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function render(suggestions: IdentitySuggestionView[]): string {
  return renderToStaticMarkup(<IdentitySuggestions suggestions={suggestions} acceptSuggestion={noop} declineSuggestion={noop} />);
}

// Every <form>…</form> in the markup.
function forms(markup: string): string[] {
  return markup.match(/<form[\s\S]*?<\/form>/g) ?? [];
}

test("the panel is titled and explains that nothing is used until the person adds it", () => {
  const text = visibleText(render([PHONE]));
  assert.match(text, /Suggested by your agents/);
  assert.match(text, /Your agent found these\. Add the ones that are right; nothing is used until you do\./);
});

test("each row shows the kind, the value and, for an address, the date they're moving there", () => {
  const text = visibleText(render([PHONE, ADDRESS, NAME]));
  assert.match(text, /Phone 0412 345 678/);
  assert.match(text, /Postal address Unit 4, 1234567890123456789012345678901234567890 Example Street, Bondi NSW 2026 · moving here on 15 Jan 2027/);
  assert.match(text, /Preferred name Phil/);
  assert.doesNotMatch(visibleText(render([PHONE])), /moving here/, "only an address with a date says it");
});

test("long values wrap rather than overflow", () => {
  const markup = render([ADDRESS]);
  assert.match(markup, /\[overflow-wrap:anywhere\][^>]*>Unit 4, 1234567890/);
});

test("where it came from is said in plain words, with the agent's name", () => {
  const text = visibleText(render([PHONE, ADDRESS, NAME]));
  assert.match(text, /Suggested by Claude · from an email from agl\.com\.au, 3 Oct 2026/);
  assert.match(text, /Suggested by ChatGPT · from your calendar, 1 Nov 2026/);
  assert.match(text, /Suggested by An agent · from a file/);
});

test("the source wording covers each service, and an unknown one is named as given", () => {
  const line = (service: string, extra: Partial<IdentitySuggestionView["source"]> = {}) =>
    suggestionSourceLine({ ...PHONE, source: { service, ...extra } });
  assert.equal(line("google-gmail"), "Suggested by Claude · from an email");
  assert.equal(line("microsoft-outlook-mail", { sender: "hr@employer.com.au" }), "Suggested by Claude · from an email from employer.com.au");
  assert.equal(line("gmail", { sender: "agl.com.au" }), "Suggested by Claude · from an email from agl.com.au");
  assert.equal(line("Outlook"), "Suggested by Claude · from an email");
  assert.equal(line("google-calendar"), "Suggested by Claude · from your calendar");
  assert.equal(line("microsoft-outlook-calendar"), "Suggested by Claude · from your calendar", "an Outlook calendar is a calendar, not email");
  assert.equal(line("google-drive"), "Suggested by Claude · from a file");
  assert.equal(line("microsoft-onedrive"), "Suggested by Claude · from a file");
  assert.equal(line("xero", { date: "2026-09-30" }), "Suggested by Claude · from xero, 30 Sept 2026");
  assert.equal(line("google-gmail", { sender: "Just A Name" }), "Suggested by Claude · from an email", "a sender with no address names no one");
  assert.equal(line("google-gmail", { date: "not a date" }), "Suggested by Claude · from an email", "an unreadable date is left out");
});

test("a suggestion that differs from the saved detail says so", () => {
  assert.match(visibleText(render([PHONE])), /Different from the one you have/);
  assert.doesNotMatch(visibleText(render([NAME])), /Different from the one you have/);
});

test("each row has its own Add and Not mine forms posting the suggestion's id, named for its kind", () => {
  const markup = render([PHONE, ADDRESS]);
  const all = forms(markup);
  assert.equal(all.length, 4, "two forms per row");
  for (const s of [PHONE, ADDRESS]) {
    const mine = all.filter((form) => form.includes(`name="id" value="${s.id}"`));
    assert.equal(mine.length, 2, `Add and Not mine each post ${s.id}`);
  }
  assert.match(markup, /<button[^>]*type="submit"[^>]*aria-label="Add phone suggestion"[^>]*>|<button[^>]*aria-label="Add phone suggestion"[^>]*type="submit"/);
  assert.match(markup, /aria-label="Not mine: phone suggestion"/);
  assert.match(markup, /aria-label="Add postal address suggestion"/);
  assert.match(markup, /aria-label="Not mine: postal address suggestion"/);
  assert.equal((markup.match(/>Add<\/button>/g) ?? []).length, 2, "one Add per row");
  assert.equal((markup.match(/>Not mine<\/button>/g) ?? []).length, 2, "one Not mine per row");
});

test("the buttons' names keep their visible words, and each is described by its value", () => {
  const markup = render([PHONE]);
  const add = markup.match(/<button[^>]*aria-label="Add phone suggestion"[^>]*>/)?.[0] ?? "";
  const describedBy = add.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy, "Add is described by the value it adds");
  assert.match(markup, new RegExp(`id="${describedBy}"[^>]*>0412 345 678`));
});

test("Add is not the page's primary action and Not mine is the quiet one", () => {
  const markup = render([PHONE]);
  const add = markup.match(/<button[^>]*aria-label="Add phone suggestion"[^>]*>/)?.[0] ?? "";
  const notMine = markup.match(/<button[^>]*aria-label="Not mine: phone suggestion"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(add, /bg-accent/, "Add is secondary: the page's one primary is Add a detail");
  assert.match(add, /border-line/);
  assert.match(notMine, /border-transparent bg-transparent/);
  for (const button of [add, notMine]) assert.match(button, /min-h-11/, "a 44px target");
  assert.doesNotMatch(add, /lg:pointer-fine:min-h-9/, "never shrinks below 44px");
});

test("there is no Add all", () => {
  const text = visibleText(render([PHONE, ADDRESS, NAME]));
  assert.doesNotMatch(text, /add all|accept all|confirm all/i);
});

test("About you shows the panel above the everyday details only when something is suggested", () => {
  const base = { lowTierFields: [], highTierFields: [] };
  const none = renderToStaticMarkup(<IdentityView {...base} suggestions={[]} acceptSuggestion={noop} declineSuggestion={noop} />);
  assert.doesNotMatch(none, /Suggested by your agents/);
  const unset = renderToStaticMarkup(<IdentityView {...base} />);
  assert.doesNotMatch(unset, /Suggested by your agents/);

  const some = renderToStaticMarkup(<IdentityView {...base} suggestions={[PHONE]} acceptSuggestion={noop} declineSuggestion={noop} />);
  const panel = some.indexOf("Suggested by your agents");
  const everyday = some.indexOf(">Everyday details</h2>");
  assert.ok(panel > 0, "the panel is shown");
  assert.ok(panel < everyday, "above the everyday details");
});

test("About you shows the outcome of the last Add or Not mine", () => {
  const markup = renderToStaticMarkup(
    <IdentityView lowTierFields={[]} highTierFields={[]} notice={{ tone: "success", text: "Added to About you." }} />,
  );
  assert.match(markup, /role="status"[\s\S]*Added to About you\./);
  const notice = markup.indexOf("Added to About you.");
  assert.ok(notice > markup.indexOf(">About you</h1>"), "after the page heading");
  assert.ok(notice < markup.indexOf(">Everyday details</h2>"), "before the first panel");
});
