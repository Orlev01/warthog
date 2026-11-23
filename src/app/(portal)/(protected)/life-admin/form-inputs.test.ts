import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingFilters, combineDateTime, itemPath, journalInput, noticeField, recordDate, recordFields, recordFilters, recordIds, recordOffsets, recordParent, recordReturnPath, recordStatus, recordTab, recordTypeId, taskReturnPath } from "./form-inputs";

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
  assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=records");
});

test("date can be cleared without turning an omitted date into a destructive edit", () => {
  const form = new FormData();
  assert.equal(recordDate(form), undefined);
  form.set("recordFormVersion", "2");
  form.set("dueDate", "");
  assert.equal(recordDate(form), null);
});

test("record return location accepts known views only", () => {
  for (const value of ["https://example.test", "receipts&notice=saved", "__proto__", "things", "subscriptions", "records"]) {
    const form = new FormData(); form.set("returnTab", value);
    assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=records");
  }
  const form = new FormData(); form.set("returnTab", "checklist");
  assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=checklist");
});

test("an action on the Records tab returns to the filters it was submitted under, well-formed values only", () => {
  const form = new FormData();
  form.set("returnTab", "records");
  for (const value of ["vehicles", "x_7kq2mz", "Vehicles'; --", "https://evil.test", "vehicles"]) form.append("returnCategory", value);
  for (const value of ["finished", "active", "everything", "finished"]) form.append("returnStatus", value);
  assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=records&category=vehicles&category=x_7kq2mz&status=active&status=finished");
  const only = new FormData();
  only.set("returnTab", "records");
  only.append("returnStatus", "active");
  assert.equal(recordReturnPath(only), "/life-admin?view=life&tab=records", "the default status is left out");
  const checklist = new FormData();
  checklist.set("returnTab", "checklist");
  checklist.append("returnCategory", "vehicles");
  assert.equal(recordReturnPath(checklist), "/life-admin?view=life&tab=checklist", "other tabs carry no record filters");
});

test("the older tabs (things, and subscriptions, receipts, renewals in reminder links) open Records", () => {
  for (const legacy of ["subscriptions", "receipts", "renewals", "things", "records", undefined, "", "nonsense"]) {
    assert.equal(recordTab(legacy), "records", String(legacy));
  }
  assert.equal(recordTab("checklist"), "checklist");
});

test("the Records filters: repeated categories and statuses, unknown ones dropped, Active when no status is left", () => {
  const ids = ["home", "vehicles", "health", "x_7kq2mz", "other"];
  assert.deepEqual(recordFilters({}, ids), { categories: [], statuses: ["active"] }, "no filter: every category, what's active");
  assert.deepEqual(
    recordFilters({ category: ["health", "vehicles", "pets", "health", "Vehicles"], status: ["finished", "active", "finished", "everything"] }, ids),
    { categories: ["vehicles", "health"], statuses: ["active", "finished"] },
    "in catalogue and list order, once each; unknown and unshaped ones dropped",
  );
  assert.deepEqual(recordFilters({ category: "x_7kq2mz", status: "cancelled" }, ids), { categories: ["x_7kq2mz"], statuses: ["cancelled"] }, "a single value, a category of the person's own");
  assert.deepEqual(recordFilters({ status: ["bogus", ""] }, ids).statuses, ["active"], "only unknown statuses: back to Active");
  assert.deepEqual(recordFilters({ status: ["on_hold", "finished", "cancelled", "active"] }, ids).statuses, ["active", "on_hold", "finished", "cancelled"]);
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
  assert.equal(withFilter(), "/life-admin?view=tasks");
  assert.equal(withFilter("any"), "/life-admin?view=tasks&assignee=any");
  assert.equal(withFilter(agentId), `/life-admin?view=tasks&assignee=${agentId}`);
  for (const value of ["", "https://evil.test", "any&notice=saved", "__proto__", `${agentId}#x`, "Zephyr"]) {
    assert.equal(withFilter(value), "/life-admin?view=tasks", `ignored: ${value}`);
  }
});

test("the new tabs open by name; anything else opens Records", () => {
  for (const tab of ["upcoming", "bookings", "checklist", "records"] as const) assert.equal(recordTab(tab), tab);
  assert.equal(recordTab("bookings&x=1"), "records");
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
  for (const bad of ["../activity", "1", "", null, "https://example.test"]) assert.equal(itemPath(bad), "/life-admin?view=life&tab=records", String(bad));
  const form = new FormData();
  form.set("recordId", "r1");
  form.set("entryKind", "next");
  form.set("text", "Book the roadworthy");
  form.set("due", "2026-11-28");
  assert.deepEqual(journalInput(form), { id: "r1", kind: "next", text: "Book the roadworthy", due: "2026-11-28" });
  form.set("entryKind", "note");
  assert.equal(journalInput(form).due, null, "only a next step takes a due date");
});

test("the Bookings filters keep only well-formed values, each repeatable", () => {
  assert.deepEqual(bookingFilters({ category: "travel", for_whom: " Mum ", state: "upcoming", page: "2" }), { categories: ["travel"], forWhom: ["Mum"], states: ["upcoming"], page: 2 });
  assert.deepEqual(bookingFilters({ category: "x_7kq2mz" }), { categories: ["x_7kq2mz"] }, "a category of the person's own");
  assert.deepEqual(
    bookingFilters({ category: ["travel", "outings", "travel"], for_whom: ["Mum", "mum", "Sam"], state: ["completed", "upcoming", "booked"] }),
    { categories: ["travel", "outings"], forWhom: ["Mum", "Sam"], states: ["upcoming", "completed"] },
    "several of each, once each, states in their usual order",
  );
  assert.deepEqual(bookingFilters({ category: "Travel'; --", state: "booked", page: "0", for_whom: "x".repeat(61) }), {});
  assert.deepEqual(bookingFilters({ page: "-1" }), {});
  assert.deepEqual(bookingFilters({ page: ["3", "9"] }), { page: 3 }, "a repeated page takes its first value");
});
