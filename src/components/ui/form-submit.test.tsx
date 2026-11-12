import * as React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionForm, FormSubmit, PendingFormFields, createFormSubmissionGuard } from "./form-submit";

test("a native form reserves its submission before React runs the action, preventing queued duplicate adds", async () => {
  const guard = createFormSubmissionGuard();
  const response = Promise.withResolvers<void>();
  let writes = 0;
  assert.equal(guard.reserve(), true);
  assert.equal(guard.reserve(), false, "the second submit event is rejected before a render or action call");
  const action = async () => { writes++; await response.promise; };
  const first = guard.run(action, new FormData());
  await guard.run(action, new FormData());
  assert.equal(writes, 1);
  response.resolve();
  await first;
  assert.equal(guard.reserve(), true, "a later deliberate submission is allowed");
});

test("form failures and framework redirects release the guard without swallowing framework control flow", async () => {
  const guard = createFormSubmissionGuard();
  const redirect = new Error("NEXT_REDIRECT");
  guard.reserve();
  await assert.rejects(guard.run(async () => { throw redirect; }, new FormData()), (error) => error === redirect);
  assert.equal(guard.reserve(), true);
});

// ─── focus-preserving pending pattern (a11y-02) ───────────────────────────────────────
// Disabling the focused field or button while a save runs throws keyboard focus back to
// <body>. The pending pattern now uses aria-disabled / aria-busy plus the guard instead.

test("release ends a reservation once its submission has settled, but never mid-run", async () => {
  const guard = createFormSubmissionGuard();
  assert.equal(guard.reserve(), true);
  assert.equal(guard.isReserved(), true);
  guard.release();
  assert.equal(guard.reserve(), true, "a settled submission frees the form for the next one");
  const response = Promise.withResolvers<void>();
  const running = guard.run(async () => { await response.promise; }, new FormData());
  guard.release();
  assert.equal(guard.reserve(), false, "a running action keeps its reservation");
  response.resolve();
  await running;
});

test("FormSubmit is a live submit button with its idle label, never natively disabled for pending", () => {
  const markup = renderToStaticMarkup(<FormSubmit pendingLabel="Saving…">Save defaults</FormSubmit>);
  assert.match(markup, /^<button[^>]*type="submit"/);
  assert.match(markup, />Save defaults<\/button>$/);
  assert.doesNotMatch(markup, /\sdisabled=""/);
  assert.doesNotMatch(markup, /aria-busy="true"|aria-disabled="true"/);
});

test("FormSubmit forwards a submitter name/value, variant and a genuine unavailable state", () => {
  const markup = renderToStaticMarkup(
    <FormSubmit pendingLabel="Denying…" name="decision" value="deny" variant="danger" disabled>Deny</FormSubmit>,
  );
  assert.match(markup, /name="decision"/);
  assert.match(markup, /value="deny"/);
  assert.match(markup, /text-danger/);
  assert.match(markup, /\sdisabled=""/, "a control that is not available at all may still be disabled");
});

test("PendingFormFields groups the fields without disabling them", () => {
  const markup = renderToStaticMarkup(<PendingFormFields><input name="title" /></PendingFormFields>);
  assert.match(markup, /<fieldset class="wh-pending-fields contents"><input name="title"\/><\/fieldset>/);
  assert.doesNotMatch(markup, /disabled/);
});

test("ActionForm renders a form around its children", () => {
  const markup = renderToStaticMarkup(
    <ActionForm action={async () => {}} className="flex flex-col gap-3"><input name="title" /></ActionForm>,
  );
  assert.match(markup, /^<form[^>]*class="flex flex-col gap-3"/);
  assert.match(markup, /<input name="title"\/>/);
});
