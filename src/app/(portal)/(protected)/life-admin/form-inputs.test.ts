import { test } from "node:test";
import assert from "node:assert/strict";
import { combineDateTime, currentLifeAdminHref, historyFilters, itemPath, journalInput, lifeAdminTab, requestedLifeAdminTab, noticeField, recordDate, recordFields, recordFilters, recordIds, recordOffsets, recordParent, recordReturnPath, recordStatus, recordTab, recordTypeId, taskReturnPath } from "./form-inputs";

test("record form keeps personal fields separate from metadata and action internals", () => {
  const form = new FormData();
  form.set("recordFormVersion", "2");
  form.set("recordId", "owner-record");
  form.set("dueDate", "2027-02-28");
  form.set("status", "upcoming");
  form.set("returnTab", "renewals");
  form.set("$ACTION_ID_example", "framework-value");
  form.set("field:title", "Licence renewal");
  form.set("field:dueDate", "A personal field, not scheduling metadata");
  assert.deepEqual(recordFields(form), { title: "Licence renewal", dueDate: "A personal field, not scheduling metadata" });
  assert.equal(recordDate(form), "2027-02-28");
  // A form left open from before typed records still lands on Records.
  assert.equal(recordReturnPath(form), "/life-admin");
});

test("date can be cleared without turning an omitted date into a destructive edit", () => {
  const form = new FormData();
  assert.equal(recordDate(form), undefined);
  form.set("recordFormVersion", "2");
  form.set("dueDate", "");
  assert.equal(recordDate(form), null);
});

test("record return location accepts known tabs only", () => {
  for (const value of ["https://example.test", "receipts&notice=saved", "__proto__", "things", "subscriptions", "records", "checklist", "tasks"]) {
    const form = new FormData(); form.set("returnTab", value);
    assert.equal(recordReturnPath(form), "/life-admin", value);
  }
  for (const value of ["upcoming", "bookings"]) {
    const form = new FormData(); form.set("returnTab", value);
    assert.equal(recordReturnPath(form), "/life-admin?tab=upcoming", value);
  }
});

test("an action on Records or in History returns to the filters it was submitted under, well-formed values only", () => {
  const form = new FormData();
  form.set("returnTab", "records");
  for (const value of ["vehicles", "x_7kq2mz", "Vehicles'; --", "https://evil.test", "vehicles"]) form.append("returnCategory", value);
  for (const value of ["on_hold", "active", "everything", "finished"]) form.append("returnStatus", value);
  assert.equal(recordReturnPath(form), "/life-admin?category=vehicles&category=x_7kq2mz&status=active&status=on_hold", "Records keeps only its own statuses");
  const only = new FormData();
  only.set("returnTab", "records");
  only.append("returnStatus", "active");
  assert.equal(recordReturnPath(only), "/life-admin", "the default status is left out");
  const history = new FormData();
  history.set("returnTab", "history");
  history.append("returnCategory", "outings");
  for (const value of ["cancelled", "active"]) history.append("returnStatus", value);
  history.set("returnPage", "2");
  assert.equal(recordReturnPath(history), "/life-admin?tab=history&history_category=outings&history_status=cancelled&history_page=2");
  const upcoming = new FormData();
  upcoming.set("returnTab", "upcoming");
  upcoming.append("returnCategory", "vehicles");
  assert.equal(recordReturnPath(upcoming), "/life-admin?tab=upcoming", "Upcoming carries no filters");
});

test("the older tabs (things, the checklist, and subscriptions, receipts, renewals in reminder links) are Records; Bookings is Upcoming", () => {
  for (const legacy of ["subscriptions", "receipts", "renewals", "things", "records", "checklist", undefined, "", "nonsense", "bookings&x=1"]) {
    assert.equal(recordTab(legacy), "records", String(legacy));
  }
  assert.equal(recordTab("bookings"), "upcoming");
  assert.equal(recordTab("history"), "history");
});

test("the tab an address opens, today's and older ones", () => {
  assert.equal(lifeAdminTab({}), "records");
  for (const tab of ["records", "upcoming", "history", "tasks"] as const) assert.equal(lifeAdminTab({ tab }), tab);
  assert.equal(lifeAdminTab({ view: "tasks" }), "tasks");
  assert.equal(lifeAdminTab({ view: "life", tab: "bookings" }), "upcoming");
  assert.equal(lifeAdminTab({ view: "life", tab: "checklist" }), "records");
  assert.equal(lifeAdminTab({ view: "life", tab: "renewals" }), "records");
  assert.equal(lifeAdminTab({ tab: "__proto__" }), "records");
});

test("an older address redirects to today's, keeping the rest of its query; a current one doesn't", () => {
  for (const current of [{}, { tab: "upcoming" }, { tab: "history", history_status: "cancelled" }, { tab: "tasks", assignee: "any" }, { category: "vehicles", status: ["active", "on_hold"] }]) {
    assert.equal(currentLifeAdminHref(current), null, JSON.stringify(current));
  }
  assert.equal(currentLifeAdminHref({ view: "tasks", assignee: "any" }), "/life-admin?tab=tasks&assignee=any");
  assert.equal(currentLifeAdminHref({ view: "life", tab: "records", category: ["vehicles", "health"], notice: "saved" }), "/life-admin?category=vehicles&category=health&notice=saved");
  assert.equal(currentLifeAdminHref({ view: "life", tab: "renewals" }), "/life-admin", "a reminder notification's link opens Records (its #record- stays with the browser)");
  assert.equal(currentLifeAdminHref({ view: "life", tab: "bookings", for_whom: "Mum", state: "upcoming", page: "2" }), "/life-admin?tab=upcoming", "the Bookings tab's own filters have no place now");
  assert.equal(currentLifeAdminHref({ view: "life", tab: "checklist" }), "/life-admin");
  assert.equal(currentLifeAdminHref({ tab: "things" }), "/life-admin");
});

test("History's filters: repeated categories and statuses, unknown ones dropped, none meaning both; a page number", () => {
  const ids = ["home", "vehicles", "outings", "x_7kq2mz"];
  assert.deepEqual(historyFilters({}, ids), { categories: [], statuses: [] });
  assert.deepEqual(
    historyFilters({ history_category: ["outings", "vehicles", "pets", "outings"], history_status: ["cancelled", "finished", "active", "bogus"], history_page: "3" }, ids),
    { categories: ["vehicles", "outings"], statuses: ["finished", "cancelled"], page: 3 },
  );
  assert.deepEqual(historyFilters({ history_page: ["0"] }, ids), { categories: [], statuses: [] });
  assert.deepEqual(historyFilters({ history_page: "-2" }, ids), { categories: [], statuses: [] });
});

test("the Records filters: repeated categories and statuses, unknown ones dropped, Active when no status is left", () => {
  const ids = ["home", "vehicles", "health", "x_7kq2mz", "other"];
  assert.deepEqual(recordFilters({}, ids), { categories: [], statuses: ["active"] }, "no filter: every category, what's active");
  assert.deepEqual(
    recordFilters({ category: ["health", "vehicles", "pets", "health", "Vehicles"], status: ["on_hold", "active", "on_hold", "everything"] }, ids),
    { categories: ["vehicles", "health"], statuses: ["active", "on_hold"] },
    "in catalogue and list order, once each; unknown and unshaped ones dropped",
  );
  assert.deepEqual(recordFilters({ category: "x_7kq2mz", status: "on_hold" }, ids), { categories: ["x_7kq2mz"], statuses: ["on_hold"] }, "a single value, a category of the person's own");
  assert.deepEqual(recordFilters({ status: ["finished", "cancelled"] }, ids).statuses, ["active"], "what's finished is History's: back to Active");
  assert.deepEqual(recordFilters({ status: ["bogus", ""] }, ids).statuses, ["active"], "only unknown statuses: back to Active");
  assert.deepEqual(recordFilters({ status: ["on_hold", "finished", "cancelled", "active"] }, ids).statuses, ["active", "on_hold"]);
  assert.deepEqual(recordFilters({ category: Array.from({ length: 200 }, () => "vehicles") }, ids).categories, ["vehicles"], "a flood of values is bounded");
});

test("the add and edit forms' type, parent and id inputs", () => {
  const form = new FormData();
  assert.equal(recordTypeId(form), "");
  assert.equal(recordParent(form), undefined, "no Belongs to choice: the link is kept");
  assert.deepEqual(recordIds(form), []);
  form.set("type", "vehicles.registration");
  form.set("parentId", "");
  form.append("recordId", "a");
  form.append("recordId", "b");
  assert.equal(recordTypeId(form), "vehicles.registration");
  assert.equal(recordParent(form), null, "Not linked clears it");
  assert.deepEqual(recordIds(form), ["a", "b"]);
  form.set("parentId", "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a01");
  assert.equal(recordParent(form), "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a01");
});

test("a refusal's field label comes back through the address only as a short plain label", () => {
  assert.equal(noticeField("Membership number"), "Membership number");
  assert.equal(noticeField("Notes (as saved)"), "Notes (as saved)");
  for (const bad of [undefined, "", "x".repeat(61), "<script>", "Click https://evil.test", "a\nb", ["Notes"]]) {
    assert.equal(noticeField(bad), null, JSON.stringify(bad));
  }
});


test("empty reminder input disables reminders; invalid entries remain rejectable", () => {
  assert.deepEqual(recordOffsets(""), []);
  assert.deepEqual(recordOffsets("  , "), []);
  assert.deepEqual(recordOffsets("14, 7, 0"), [14, 7, 0]);
  assert.ok(Number.isNaN(recordOffsets("14,typo")[1]));
});


test("forms open before deployment retain legacy personal fields without changing metadata", () => {
  const form = new FormData();
  form.set("recordId", "record"); form.set("name", "Legacy title");
  form.set("dueDate", "Personal date notes"); form.set("status", "Personal status notes");
  form.set("$ACTION_ID_old", "framework");
  assert.deepEqual(recordFields(form), { name: "Legacy title", dueDate: "Personal date notes", status: "Personal status notes" });
  assert.equal(recordDate(form), undefined);
  assert.equal(recordStatus(form), undefined);
});

test("a task action returns to the Tasks view, keeping a well-formed assignee filter only", () => {
  const agentId = "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a01";
  const withFilter = (value?: string) => {
    const form = new FormData();
    form.set("taskId", "task");
    if (value !== undefined) form.set("returnAssignee", value);
    return taskReturnPath(form);
  };
  assert.equal(withFilter(), "/life-admin?tab=tasks");
  assert.equal(withFilter("any"), "/life-admin?tab=tasks&assignee=any");
  assert.equal(withFilter(agentId), `/life-admin?tab=tasks&assignee=${agentId}`);
  for (const value of ["", "https://evil.test", "any&notice=saved", "__proto__", `${agentId}#x`, "Zephyr"]) {
    assert.equal(withFilter(value), "/life-admin?tab=tasks", `ignored: ${value}`);
  }
});

test("a date-time picker's wall time and zone combine on the server into the canonical stored value", () => {
  assert.equal(combineDateTime("2026-12-03T19:30", "Australia/Sydney"), "2026-12-03T19:30+11:00[Australia/Sydney]");
  assert.equal(combineDateTime("2026-07-03T19:30", "Australia/Sydney"), "2026-07-03T19:30+10:00[Australia/Sydney]", "the offset follows daylight saving");
  assert.equal(combineDateTime("2027-01-03T00:30", "Asia/Tokyo"), "2027-01-03T00:30+09:00[Asia/Tokyo]");
  assert.equal(combineDateTime("2026-12-03T19:30", "offset:+05:30"), "2026-12-03T19:30+05:30", "a value saved with an offset only keeps it");
  assert.equal(combineDateTime("2026-12-03T19:30", "Mars/Olympus"), "2026-12-03T19:30", "an unknown zone leaves it for the person's own zone");
  assert.equal(combineDateTime("2026-12-03T00:00", "Australia/Sydney", "2026-12-03"), "2026-12-03", "a date alone stays a date unless a time is added");
  assert.equal(combineDateTime("2026-12-03T09:15", "Australia/Sydney", "2026-12-03"), "2026-12-03T09:15+11:00[Australia/Sydney]");
  assert.equal(combineDateTime("", "Australia/Sydney"), "", "an emptied picker clears the field");
  assert.equal(combineDateTime("next Friday", "Australia/Sydney"), "next Friday", "anything else is left for the record service to report");

  const form = new FormData();
  form.set("recordFormVersion", "2");
  form.set("field:starts_at", "2026-12-03T19:30");
  form.set("zone:starts_at", "Asia/Tokyo");
  form.set("field:cancel_by", "2026-12-01T00:00");
  form.set("zone:cancel_by", "Australia/Sydney");
  form.set("dateonly:cancel_by", "2026-12-01");
  form.set("field:provider", "Sushi Saito");
  assert.deepEqual(recordFields(form), { starts_at: "2026-12-03T19:30+09:00[Asia/Tokyo]", cancel_by: "2026-12-01", provider: "Sushi Saito" }, "the zone and date-only markers are never fields of their own");
});

test("the item page's inputs: its address, and the journal form", () => {
  assert.equal(itemPath("0F8A4B2C-1D3E-4F5A-8B9C-0D1E2F3A4B5C"), "/life-admin/items/0f8a4b2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c");
  for (const bad of ["../activity", "1", "", null, "https://example.test"]) assert.equal(itemPath(bad), "/life-admin", String(bad));
  const form = new FormData();
  form.set("recordId", "r1");
  form.set("entryKind", "next");
  form.set("text", "Book the roadworthy");
  form.set("due", "2026-11-28");
  assert.deepEqual(journalInput(form), { id: "r1", kind: "next", text: "Book the roadworthy", due: "2026-11-28" });
  form.set("entryKind", "note");
  assert.equal(journalInput(form).due, null, "only a next step takes a due date");
});

test("a browser address's query maps the same way", async () => {
  const { currentLifeAdminSearch } = await import("@/components/life-admin/tab-address");
  assert.equal(currentLifeAdminSearch("?view=life&tab=renewals"), "/life-admin");
  assert.equal(currentLifeAdminSearch("?view=tasks&assignee=any"), "/life-admin?tab=tasks&assignee=any");
  assert.equal(currentLifeAdminSearch("?tab=history&history_status=cancelled"), null);
  assert.equal(currentLifeAdminSearch(""), null);
});

// The Add tab (founder, 24 Nov 2026): what's still to fill in and adding records, apart from
// Records, which keeps what's on file.
test("the Add tab has its own address, and what's done there comes back to it", () => {
  assert.equal(lifeAdminTab({ tab: "add" }), "add");
  assert.equal(recordTab("add"), "add");
  const form = new FormData();
  form.set("returnTab", "add");
  form.append("returnCategory", "vehicles");
  assert.equal(recordReturnPath(form), "/life-admin?tab=add", "Add carries no filters");
});

test("an address names a tab only when it asks for one; picking a kind to add asks for Add", () => {
  assert.equal(requestedLifeAdminTab({}), undefined, "no tab: the page picks (Add when nothing is on file)");
  assert.equal(requestedLifeAdminTab({ tab: "records" }), "records");
  assert.equal(requestedLifeAdminTab({ tab: "upcoming" }), "upcoming");
  assert.equal(requestedLifeAdminTab({ view: "tasks" }), "tasks");
  assert.equal(requestedLifeAdminTab({ view: "life", tab: "renewals" }), "records", "reminder links still open the record's tab");
  assert.equal(requestedLifeAdminTab({ add: "vehicles.registration" }), "add");
  assert.equal(requestedLifeAdminTab({ tab: "nonsense" }), "records", "an unknown tab is Records, as before");
});
