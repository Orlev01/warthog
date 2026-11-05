// E10-S11 — the single confirm that gates a Disconnect
// (`src/app/(portal)/(protected)/agents/disconnect-confirm.tsx`), mounted by the
// Agents list page around <AgentListView/>.
//
// RED-first: the disconnect-confirm module does NOT exist yet, so importing
// `./disconnect-confirm` throws (ERR_MODULE_NOT_FOUND) and every test here fails
// until the builder adds it. That absence IS the point of test-first — do NOT
// implement anything to make these pass.
//
// WHY this exists (task E10-S11, AC "Disconnect asks for a single confirm before
// calling disconnectAgent"): disconnecting an agent is destructive (its very next
// request is refused, its pending approvals denied, its uncollected releases
// cancelled — E10-S09), so the Agents list must ask the person to confirm ONCE
// before the disconnect runs. The merged E10-S10 AgentListView renders each
// Disconnect as a `<form action={disconnectAction}>` (a submit over the action the
// page passes); the page gates that action behind a single confirm by wrapping it on
// the client.
//
// WHY a framework-free controller (not a DOM test): there is no jsdom / testing-
// library on this job and React component / E2E testing is a per-job ADR, so the
// browser `confirm` interaction is NOT driven through a rendered DOM. As the sibling
// client flows do (auth factor-controls / sign-in / sign-up export an injectable,
// framework-free controller alongside their `"use client"` component), the gating
// logic lives in an injectable seam that `disconnect-confirm.tsx` exports and its
// `"use client"` component defaults to the browser's `window.confirm`. These tests
// drive that seam directly with FAKE seams and assert what it DOES — that a single
// confirm is asked, that the real disconnect action runs ONLY on a yes, and that the
// submitted form data (carrying the agent id) is forwarded — never the source text of
// the module. A later behaviour-preserving refactor stays green.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createDisconnectConfirm(deps: {
//     disconnect: (formData: FormData) => void | Promise<void>; // the bound disconnect action
//     confirm: (message?: string) => boolean;                   // the confirm seam (⇐ window.confirm)
//   }): DisconnectAction | { action: DisconnectAction }
//     where DisconnectAction = (formData: FormData) => void | Promise<void>
//
//   The returned action is what the page hands to <AgentListView disconnectAction=…>.
//   On submit it asks the confirm seam EXACTLY ONCE and calls `disconnect` (forwarding
//   the submitted FormData) only when confirm returns true; a cancelled confirm calls
//   `disconnect` not at all.
//
// This file is `.ts` (no JSX): it imports only the framework-free controller, never
// renders the component.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDisconnectConfirm } from "./disconnect-confirm";

// The agent id the view's hidden field carries into the submitted form — the disconnect
// action must receive it so it disconnects the right agent.
const AGENT_ID = "11111111-2222-4333-8444-555555555555";

type DisconnectAction = (formData: FormData) => void | Promise<void>;

// The returned seam may be the action itself, or an object exposing it as `action`
// (both are natural shapes for "hand this to disconnectAction") — accept either, so
// the test pins the gating BEHAVIOUR, not the wrapper's exact shape.
function actionFrom(made: unknown): DisconnectAction {
  if (typeof made === "function") return made as DisconnectAction;
  if (made && typeof (made as { action?: unknown }).action === "function") {
    return (made as { action: DisconnectAction }).action;
  }
  assert.fail(
    "createDisconnectConfirm must return a disconnect action (a function) or an object with an `action` function",
  );
}

// A FormData carrying the agent id, exactly as the view's Disconnect form submits.
function disconnectForm(): FormData {
  const fd = new FormData();
  fd.set("agentId", AGENT_ID);
  return fd;
}

// A recording disconnect action + a configurable confirm seam, with a shared ordered
// log so "confirm is asked before disconnect runs" is observable.
function harness(confirmReturns: boolean) {
  const order: string[] = [];
  let confirmCalls = 0;
  let received: FormData | null = null;
  const confirm = (_message?: string): boolean => {
    confirmCalls += 1;
    order.push("confirm");
    return confirmReturns;
  };
  const disconnect: DisconnectAction = async (formData: FormData) => {
    order.push("disconnect");
    received = formData;
  };
  return {
    confirm,
    disconnect,
    get confirmCalls() {
      return confirmCalls;
    },
    get received() {
      return received;
    },
    order,
  };
}

test("a confirmed disconnect asks a single confirm, then runs the disconnect with the submitted form", async () => {
  const h = harness(true);
  const action = actionFrom(createDisconnectConfirm({ disconnect: h.disconnect, confirm: h.confirm }));

  const fd = disconnectForm();
  await Promise.resolve(action(fd));

  // A SINGLE confirm was asked…
  assert.equal(h.confirmCalls, 1, "exactly one confirm must be asked before a disconnect");
  // …before the disconnect ran…
  assert.deepEqual(h.order, ["confirm", "disconnect"], "the confirm must be asked BEFORE the disconnect runs");
  // …and the disconnect received the submitted form carrying the agent id (so it
  // disconnects the right agent).
  const received = h.received as FormData | null;
  assert.ok(
    received !== null && typeof received.get === "function" && received.get("agentId") === AGENT_ID,
    "the disconnect action must receive the submitted FormData carrying the agent id",
  );
});

test("a cancelled confirm does NOT run the disconnect (but still asked exactly once)", async () => {
  const h = harness(false);
  const action = actionFrom(createDisconnectConfirm({ disconnect: h.disconnect, confirm: h.confirm }));

  await Promise.resolve(action(disconnectForm()));

  assert.equal(h.confirmCalls, 1, "a single confirm is asked even when the person cancels");
  assert.deepEqual(h.order, ["confirm"], "a cancelled confirm must NOT run the disconnect");
  assert.equal(h.received, null, "the disconnect action is never called when the person cancels");
});
