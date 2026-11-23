import { test } from "node:test";
import assert from "node:assert/strict";
import { noticeField, recordDate, recordFields, recordIds, recordOffsets, recordParent, recordReturnPath, recordStatus, recordTab, recordTypeId, taskReturnPath } from "./form-inputs";

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
  // A form left open from before typed records still lands on "Your things".
  assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=things");
});

test("date can be cleared without turning an omitted date into a destructive edit", () => {
  const form = new FormData();
  assert.equal(recordDate(form), undefined);
  form.set("recordFormVersion", "2");
  form.set("dueDate", "");
  assert.equal(recordDate(form), null);
});

test("record return location accepts known views only", () => {
  for (const value of ["https://example.test", "receipts&notice=saved", "__proto__", "things", "subscriptions"]) {
    const form = new FormData(); form.set("returnTab", value);
    assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=things");
  }
  const form = new FormData(); form.set("returnTab", "checklist");
  assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=checklist");
});

test("the older tabs in reminder links (subscriptions, receipts, renewals) open Your things", () => {
  for (const legacy of ["subscriptions", "receipts", "renewals", "things", undefined, "", "nonsense"]) {
    assert.equal(recordTab(legacy), "things", String(legacy));
  }
  assert.equal(recordTab("checklist"), "checklist");
});

test("the add and edit forms' type, parent and id inputs", () => {
  const form = new FormData();
  assert.equal(recordTypeId(form), "");
  assert.equal(recordParent(form), undefined, "no Belongs to choice: the link is kept");
  assert.deepEqual(recordIds(form), []);
  form.set("type", "vehicle.registration");
  form.set("parentId", "");
  form.append("recordId", "a");
  form.append("recordId", "b");
  assert.equal(recordTypeId(form), "vehicle.registration");
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
