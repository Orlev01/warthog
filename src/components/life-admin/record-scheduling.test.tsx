import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LifeAdminView } from "./life-admin-view";

test("record forms expose scheduling metadata and preserve personal field names", () => {
  const html = renderToStaticMarkup(<LifeAdminView subscriptions={[]} receipts={[]} checklist={[]}
    renewals={[{id:"00000000-0000-4000-8000-000000000001",kind:"renewal_appointment",fields:{title:"Licence",dueDate:"Personal text"},dueDate:"2027-02-28",status:"upcoming",reminderOffsets:[14,1]}]}
    initialTab="renewals" addRecordAction={async()=>{}} editRecordAction={async()=>{}} />);
  assert.match(html,/type="date"[^>]*name="dueDate"/);
  assert.match(html,/name="dueDate"[^>]*value="2027-02-28"/);
  assert.match(html,/name="status"[^>]*value="upcoming"/);
  assert.match(html,/name="field:dueDate"[^>]*value="Personal text"/);
  assert.match(html,/id="record-00000000-0000-4000-8000-000000000001"/);
  assert.match(html,/name="returnTab"[^>]*value="renewals"/);
});
