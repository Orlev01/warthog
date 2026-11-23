// Review fix G1 — add and edit an everyday ("low-tier") detail on the Vault "About you"
// screen (src/components/vault/low-tier-detail-flow.tsx).
//
// Before this fix the "About you" fields had no name, no form and no Save button: a new
// person could not enter their name, email, phone or postal address (brief flow 2),
// edits to an existing value were thrown away, and a postal address's moving-on date —
// the day an address the person is moving to becomes their current one — could never be
// set from the UI.
//
// The module follows the repo's render-testable-AND-interactive split (HighTierFlow +
// createHighTierFlow, AddCardFlow + createAddCardFlow):
//   1. LowTierDetailFlow — the Client Component. ADD mode: closed it is a live "Add a
//      detail" control; open it is a kind picker, a value field (plus a moving-on date for
//      a postal address) and a Save control. EDIT mode: the field's value (and an address's
//      moving-on date) as named, editable controls with a Save control.
//   2. createLowTierDetailFlow(deps) — the framework-free controller behind Save: it
//      validates, calls the page's saveLowTierField / updateLowTierField action with
//      exactly the person's input, and reports every outcome in plain words.
//
// Behaviour only: the controller is DRIVEN with fake actions and its calls/state are
// asserted; the component is rendered with react-dom/server and its markup read.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createLowTierDetailFlow, LowTierDetailFlow } from "./low-tier-detail-flow";

type Call = Record<string, unknown>;

function recorder(result: { ok: boolean; reason?: string } = { ok: true }) {
  const calls: Call[] = [];
  const action = async (input: Call) => {
    calls.push(input);
    return result;
  };
  return { calls, action };
}

const ADDRESS = {
  id: "6f1c2a52-6f0e-4c8e-9a51-0d7f0e0b5a11",
  kind: "postal_address" as const,
  value: "1 Old Rd, Hobart",
  movingOn: null,
};
const EMAIL = {
  id: "0b3a6b0e-2f45-4d0a-8f43-5a8d1f2b9c77",
  kind: "email" as const,
  value: "ada@banksia.example",
  movingOn: null,
};

// --- the controller -------------------------------------------------------------------

test("ADD: saving a postal address with a moving-on date calls saveLowTierField with exactly that input", async () => {
  const save = recorder();
  const flow = createLowTierDetailFlow({ mode: "add", saveLowTierField: save.action });
  flow.setKind("postal_address");
  flow.setValue("  9 New St, Darwin  ");
  flow.setMovingOn("2026-12-01");
  await flow.submit();

  assert.deepEqual(save.calls, [{ kind: "postal_address", value: "9 New St, Darwin", movingOn: "2026-12-01" }]);
  assert.equal(flow.getState().status, "saved");
  // The add form is cleared for the next detail.
  assert.equal(flow.getState().value, "");
  assert.equal(flow.getState().movingOn, "");
});

test("ADD: a moving-on date is never sent for a detail that is not a postal address", async () => {
  const save = recorder();
  const flow = createLowTierDetailFlow({ mode: "add", saveLowTierField: save.action });
  flow.setKind("postal_address");
  flow.setMovingOn("2026-12-01");
  flow.setKind("phone");
  flow.setValue("0400 000 000");
  await flow.submit();
  assert.deepEqual(save.calls, [{ kind: "phone", value: "0400 000 000" }]);
});

test("an empty value is refused in plain words and nothing is sent", async () => {
  const save = recorder();
  const flow = createLowTierDetailFlow({ mode: "add", saveLowTierField: save.action });
  flow.setValue("   ");
  await flow.submit();
  assert.equal(save.calls.length, 0);
  assert.equal(flow.getState().status, "error");
  assert.match(flow.getState().error ?? "", /type|enter/i);
});

test("EDIT: Save calls updateLowTierField with the field id and the edited value", async () => {
  const update = recorder();
  const flow = createLowTierDetailFlow({ mode: "edit", field: EMAIL, updateLowTierField: update.action });
  flow.setValue("ada@new.example");
  await flow.submit();
  assert.deepEqual(update.calls, [{ fieldId: EMAIL.id, value: "ada@new.example" }]);
  assert.equal(flow.getState().status, "saved");
  assert.equal(flow.getState().value, "ada@new.example", "an edited value stays on screen after saving");
});

test("EDIT: a postal address sends its moving-on date, and clearing the date sends null", async () => {
  const update = recorder();
  const flow = createLowTierDetailFlow({ mode: "edit", field: ADDRESS, updateLowTierField: update.action });
  flow.setMovingOn("2027-01-15");
  await flow.submit();
  flow.setMovingOn("");
  await flow.submit();
  assert.deepEqual(update.calls, [
    { fieldId: ADDRESS.id, value: ADDRESS.value, movingOn: "2027-01-15" },
    { fieldId: ADDRESS.id, value: ADDRESS.value, movingOn: null },
  ]);
});

test("a refused or failed save shows a plain notice and never claims success", async () => {
  const refused = createLowTierDetailFlow({
    mode: "edit",
    field: EMAIL,
    updateLowTierField: async () => ({ ok: false, reason: "not_found" }),
  });
  await refused.submit();
  assert.equal(refused.getState().status, "error");
  assert.ok(refused.getState().error && !/not_found/.test(refused.getState().error!), "no raw machine reason");

  const thrown = createLowTierDetailFlow({
    mode: "add",
    saveLowTierField: async () => {
      throw new Error("network");
    },
  });
  thrown.setValue("Ada");
  await thrown.submit();
  assert.equal(thrown.getState().status, "error");
});

test("a second Save while the first is in flight is ignored (no duplicate detail)", async () => {
  let release: () => void = () => {};
  const calls: Call[] = [];
  const flow = createLowTierDetailFlow({
    mode: "add",
    saveLowTierField: (input) => {
      calls.push(input);
      return new Promise((resolve) => {
        release = () => resolve({ ok: true });
      });
    },
  });
  flow.setValue("Ada Banks");
  const first = flow.submit();
  const second = flow.submit();
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
});

// --- the component --------------------------------------------------------------------

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
}

test("ADD closed: a live 'Add a detail' control and no value field", () => {
  const markup = renderToStaticMarkup(<LowTierDetailFlow mode="add" saveLowTierField={async () => ({ ok: true })} />);
  assert.match(visibleText(markup), /Add a detail/);
  assert.ok(!/<input/i.test(markup), "no value field until the person opens the add form");
});

test("ADD open: a labelled kind picker over the everyday kinds, a value field and a Save button", () => {
  const markup = renderToStaticMarkup(
    <LowTierDetailFlow mode="add" initialOpen saveLowTierField={async () => ({ ok: true })} />,
  );
  assert.match(markup, /<select[^>]*name="kind"/);
  for (const label of ["Name", "Email", "Phone", "Postal address"]) {
    assert.ok(visibleText(markup).includes(label), `the kind picker offers ${label}`);
  }
  assert.match(markup, /<input[^>]*name="value"/);
  assert.match(markup, /<button[^>]*type="submit"[^>]*>[\s\S]*?Save/);
});

test("EDIT: the value (and an address's moving-on date) render as named controls with a Save button", () => {
  const markup = renderToStaticMarkup(
    <LowTierDetailFlow mode="edit" field={{ ...ADDRESS, movingOn: "2027-09-15" }} label="Postal address" updateLowTierField={async () => ({ ok: true })} />,
  );
  assert.match(markup, /<input[^>]*name="value"[^>]*value="1 Old Rd, Hobart"|<input[^>]*value="1 Old Rd, Hobart"[^>]*name="value"/);
  assert.match(markup, /<input[^>]*type="date"[^>]*name="movingOn"|<input[^>]*name="movingOn"[^>]*type="date"/);
  assert.ok(markup.includes("2027-09-15"));
  assert.match(visibleText(markup), /Moving date \(optional\)/);
  assert.match(markup, /<button[^>]*type="submit"[^>]*>[\s\S]*?Save/);
});
