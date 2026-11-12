import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFields, recordDate, recordReturnPath, recordOffsets, recordStatus, recordTitle, taskReturnPath } from "./form-inputs";

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
  assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=renewals");
});

test("date can be cleared without turning an omitted date into a destructive edit", () => {
  const form = new FormData();
  assert.equal(recordDate(form), undefined);
  form.set("recordFormVersion", "2");
  form.set("dueDate", "");
  assert.equal(recordDate(form), null);
});

test("record return location accepts known views only", () => {
  for (const value of ["https://example.test", "receipts&notice=saved", "__proto__"]) {
    const form = new FormData(); form.set("returnTab", value);
    assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=subscriptions");
  }
  const form = new FormData(); form.set("returnTab", "receipts");
  assert.equal(recordReturnPath(form), "/life-admin?view=life&tab=receipts");
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

test("a record name made only of spaces is refused (null), and a real one is trimmed", () => {
  for (const raw of ["", "   ", "\t\n "]) {
    const form = new FormData();
    form.set("title", raw);
    assert.equal(recordTitle(form), null, `blank: ${JSON.stringify(raw)}`);
  }
  assert.equal(recordTitle(new FormData()), null, "missing");
  const form = new FormData();
  form.set("title", "  Netflix Premium ");
  assert.equal(recordTitle(form), "Netflix Premium");
});
