// Life admin's address names the tab shown whenever it isn't the page's default for this person
// (Records, or Add while nothing is on file), so the server and the browser always agree on the
// tab (src/components/life-admin/tab-address.ts; docs/adr/life-admin-profile.md).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ADD_ANCHOR, ADD_TAB_HREF, addFormRedirect, shownLifeAdminAddress } from "./tab-address";

test("the Add tab's address and its form's anchor", () => {
  assert.equal(ADD_TAB_HREF, "/life-admin?tab=add");
  assert.equal(ADD_ANCHOR, "new-record");
});

test("an address already naming what's shown is left alone", () => {
  assert.equal(shownLifeAdminAddress("", "", "records", "records"), null);
  assert.equal(shownLifeAdminAddress("", "", "add", "add"), null);
  assert.equal(shownLifeAdminAddress("?tab=add", "#new-record", "add", "records"), null);
  assert.equal(shownLifeAdminAddress("?tab=upcoming&notice=saved", "", "upcoming", "add"), null);
});

test("a kind to add without a tab names Add, so the browser keeps the form the page opened", () => {
  assert.equal(shownLifeAdminAddress("?add=vehicles.registration", "#new-record", "add", "records"), "/life-admin?tab=add&add=vehicles.registration#new-record");
  assert.equal(shownLifeAdminAddress("?add=home.lease&notice=invalid_input", "", "add", "records"), "/life-admin?tab=add&add=home.lease&notice=invalid_input");
});

test("with nothing on file, an older or unknown tab the page opened as Records stays Records, its notice with it", () => {
  assert.equal(shownLifeAdminAddress("?tab=checklist", "", "records", "add"), "/life-admin?tab=records");
  assert.equal(shownLifeAdminAddress("?view=life&tab=things", "", "records", "add"), "/life-admin?tab=records");
  assert.equal(shownLifeAdminAddress("?tab=nonsense&notice=saved", "", "records", "add"), "/life-admin?tab=records&notice=saved");
});

test("older addresses still map, keeping the record anchor, and the default tab needs no name", () => {
  assert.equal(shownLifeAdminAddress("?view=life&tab=renewals", "#record-abc", "records", "records"), "/life-admin#record-abc");
  assert.equal(shownLifeAdminAddress("?view=life&tab=bookings", "", "upcoming", "records"), "/life-admin?tab=upcoming");
  assert.equal(shownLifeAdminAddress("?view=tasks", "", "tasks", "records"), "/life-admin?tab=tasks");
  assert.equal(shownLifeAdminAddress("?tab=records&category=vehicles", "", "records", "records"), "/life-admin?category=vehicles");
});

test("an old link to the add form without a tab goes to the Add tab's address", () => {
  assert.equal(addFormRedirect("", "#new-record", "records"), "/life-admin?tab=add#new-record");
  assert.equal(addFormRedirect("?category=vehicles", "#new-record", "records"), "/life-admin?tab=add#new-record");
  assert.equal(addFormRedirect("", "#new-record", "add"), null, "already on Add");
  assert.equal(addFormRedirect("?tab=upcoming", "#new-record", "upcoming"), null, "a named tab wins");
  assert.equal(addFormRedirect("", "#record-abc", "records"), null);
});
