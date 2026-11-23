import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LifeAdminView } from "./life-admin-view";

// The edit form posts scheduling metadata (due date, status) apart from the record's own
// fields, which travel as `field:<key>` — so a personal field named "dueDate" stays a field.
test("record forms expose scheduling metadata and preserve personal field names", () => {
  const html = renderToStaticMarkup(<LifeAdminView today="2026-11-12" checklist={[]}
    records={[{id:"00000000-0000-4000-8000-000000000001",kind:"renewal_appointment",fields:{title:"Licence",dueDate:"Personal text"},dueDate:"2027-02-28",status:"upcoming",reminderOffsets:[14,1]}]}
    addRecordAction={async()=>{}} editRecordAction={async()=>{}} />);
  assert.match(html,/type="date"[^>]*name="dueDate"/);
  assert.match(html,/name="dueDate"[^>]*value="2027-02-28"/);
  // The status is a choice; an older record's own value ("upcoming") is kept as the selected option.
  assert.match(html,/<select[^>]*name="status"/);
  assert.match(html,/<option value="upcoming" selected="">Upcoming<\/option>/);
  assert.match(html,/name="field:dueDate"[^>]*value="Personal text"/);
  assert.match(html,/id="record-00000000-0000-4000-8000-000000000001"/);
  assert.match(html,/name="returnTab"[^>]*value="things"/);
});
