// E18-S03 — Set-up checklist status helper (src/domain/home/checklist.ts).
//
// RED-first: src/domain/home/checklist.ts does NOT exist yet, so importing
// `./checklist` fails and every test here is red until the builder adds the
// module. That absence is the whole point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what computeSetupChecklist RETURNS for given
// signals — never the source text of checklist.ts. A behaviour-preserving
// refactor (different internal shape, extra helpers, an added stable `key`
// field) stays green as long as the five items, their labels/links, and the
// done rule keep behaving the same way.
//
// WHY this module exists: the home set-up checklist (brief design_ux "HOME — a
// set-up checklist", Home dashboard requirement) must show items as done from
// real account state. Keeping the five item definitions and the "done" rule in
// ONE pure, testable place fixes the exact five items and their links for every
// consumer (the status read E18-S04 that produces the signals, and the
// component E18-S06 that renders them).
//
// The contract the builder implements (exactly this):
//
//   type SetupSignals = {        // account state; each flag may be absent
//     notificationsEnabled?: boolean;   // "Get notified" done
//     identityAdded?: boolean;          // "Add your details" done
//     cardAdded?: boolean;              // "Add a card" done   (named by the task)
//     serviceConnected?: boolean;       // "Connect a service" done
//     agentConnected?: boolean;         // "Connect an agent" done (named by the task)
//   };
//
//   type SetupChecklistItem = { label: string; href: string; done: boolean };
//
//   computeSetupChecklist(signals: SetupSignals): SetupChecklistItem[]
//     — returns EXACTLY the five first-run items, in documented order (UI/UX pass,
//       newcomer-01: the step that makes Warthog work first, the optional card last):
//         Connect an agent  -> /agents/connect            (agentConnected)
//         Connect a service -> /connectors                (serviceConnected)
//         Add your details  -> /vault                    (identityAdded)
//         Get notified      -> /settings/notifications   (notificationsEnabled)
//         Add a card        -> /vault/cards               (cardAdded)
//       Each item keeps its label and href regardless of signals; only `done`
//       varies. An item is done IFF its own signal is present/truthy — so with
//       every signal absent all five are not done, and e.g. agentConnected
//       marks "Connect an agent" done and cardAdded marks "Add a card" done.
//
// The signal names `agentConnected` and `cardAdded` are fixed by the task; the
// other three (notificationsEnabled, identityAdded, serviceConnected) are fixed
// here as the cross-task contract for E18-S04 to populate and E18-S06 to render.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeSetupChecklist } from "./checklist";

// --- structural view of the returned items (runtime-tolerant) ---------------

type SetupChecklistItem = {
  label: string;
  href: string;
  done: boolean;
};

// The five signal flags, each optional. Tests build these as plain objects so
// they compile against whatever compatible shape the builder picks.
type SetupSignals = {
  notificationsEnabled?: boolean;
  identityAdded?: boolean;
  cardAdded?: boolean;
  serviceConnected?: boolean;
  agentConnected?: boolean;
};

// The documented five items, in order: label, link, and the signal that marks
// it done. This table IS the contract these tests enforce.
const EXPECTED: ReadonlyArray<{
  label: string;
  href: string;
  signal: keyof SetupSignals;
}> = [
  { label: "Connect an agent", href: "/agents/connect", signal: "agentConnected" },
  { label: "Connect a service", href: "/connectors", signal: "serviceConnected" },
  { label: "Add your details", href: "/vault", signal: "identityAdded" },
  { label: "Get notified", href: "/settings/notifications", signal: "notificationsEnabled" },
  { label: "Add a card", href: "/vault/cards", signal: "cardAdded" },
];

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Run the helper and read the result through the structural item type.
function run(signals: SetupSignals): readonly SetupChecklistItem[] {
  const items = computeSetupChecklist(signals as unknown as never) as unknown;
  assert.ok(Array.isArray(items), "computeSetupChecklist must return an array of items");
  return items as readonly SetupChecklistItem[];
}

// The one item at a given href (hrefs are the stable identity across signals).
function byHref(items: readonly SetupChecklistItem[], href: string): SetupChecklistItem {
  const found = items.filter((i) => i.href === href);
  assert.equal(found.length, 1, `exactly one checklist item must link to ${href}, got ${found.length}`);
  return found[0]!;
}

// --- the five items: identity (label + link), order, exactly five -----------

test("returns exactly five checklist items", () => {
  const items = run({});
  assert.equal(
    items.length,
    5,
    `exactly five set-up items expected, got ${items.length}: ${JSON.stringify(items.map((i) => i.label))}`,
  );
});

test("the five items carry their documented labels and links, in order", () => {
  const items = run({});
  // Links in documented order — the stable cross-consumer contract.
  assert.deepEqual(
    items.map((i) => i.href),
    EXPECTED.map((e) => e.href),
    "the five items must link to /agents/connect, /connectors, /vault, /settings/notifications, /vault/cards, in that order (connecting an agent first; the optional card last)",
  );
  // Each item keeps its documented label, in the same order.
  EXPECTED.forEach((e, i) => {
    assert.equal(
      norm(items[i]!.label),
      norm(e.label),
      `item ${i} must be labelled "${e.label}" (-> ${e.href}), got "${items[i]!.label}"`,
    );
  });
});

test("each documented item exists with the right label at its link", () => {
  const items = run({});
  for (const e of EXPECTED) {
    const item = byHref(items, e.href);
    assert.equal(
      norm(item.label),
      norm(e.label),
      `the item linking to ${e.href} must be labelled "${e.label}", got "${item.label}"`,
    );
  }
});

test("labels and links do not change when signals change (only done varies)", () => {
  const allOn: SetupSignals = {
    notificationsEnabled: true,
    identityAdded: true,
    cardAdded: true,
    serviceConnected: true,
    agentConnected: true,
  };
  const empty = run({}).map((i) => ({ label: i.label, href: i.href }));
  const full = run(allOn).map((i) => ({ label: i.label, href: i.href }));
  assert.deepEqual(
    full,
    empty,
    "the item definitions (label + href, in order) must be identical whatever the signals",
  );
});

// --- the done rule ----------------------------------------------------------

test("with every signal absent, all five items are not done", () => {
  const items = run({});
  for (const item of items) {
    assert.equal(item.done, false, `${item.label} (${item.href}) must be not done when no signals are present`);
  }
});

test("`done` is a boolean flag on every item", () => {
  for (const signals of [{}, { agentConnected: true } as SetupSignals]) {
    for (const item of run(signals)) {
      assert.equal(typeof item.done, "boolean", `${item.label} must carry a boolean done flag`);
    }
  }
});

test("each present signal marks ONLY its own item done", () => {
  for (const target of EXPECTED) {
    const signals = { [target.signal]: true } as SetupSignals;
    const items = run(signals);
    for (const other of EXPECTED) {
      const item = byHref(items, other.href);
      const expectDone = other.signal === target.signal;
      assert.equal(
        item.done,
        expectDone,
        `with only ${String(target.signal)} present, ${other.label} (${other.href}) should be ${
          expectDone ? "done" : "not done"
        }`,
      );
    }
  }
});

test("agentConnected marks Connect an agent done (and nothing else)", () => {
  const items = run({ agentConnected: true });
  assert.equal(byHref(items, "/agents/connect").done, true, "agentConnected must mark Connect an agent done");
  assert.equal(byHref(items, "/vault/cards").done, false, "agentConnected must not mark Add a card done");
  assert.equal(
    byHref(items, "/settings/notifications").done,
    false,
    "agentConnected must not mark Get notified done",
  );
});

test("cardAdded marks Add a card done (and nothing else)", () => {
  const items = run({ cardAdded: true });
  assert.equal(byHref(items, "/vault/cards").done, true, "cardAdded must mark Add a card done");
  assert.equal(byHref(items, "/agents/connect").done, false, "cardAdded must not mark Connect an agent done");
  assert.equal(byHref(items, "/connectors").done, false, "cardAdded must not mark Connect a service done");
});

test("a signal present but false leaves its item not done (done tracks the truthy signal)", () => {
  const items = run({
    notificationsEnabled: false,
    identityAdded: false,
    cardAdded: false,
    serviceConnected: false,
    agentConnected: false,
  });
  for (const item of items) {
    assert.equal(item.done, false, `${item.label} must be not done when its signal is false`);
  }
});

test("with every signal present, all five items are done", () => {
  const items = run({
    notificationsEnabled: true,
    identityAdded: true,
    cardAdded: true,
    serviceConnected: true,
    agentConnected: true,
  });
  for (const item of items) {
    assert.equal(item.done, true, `${item.label} (${item.href}) must be done when its signal is present`);
  }
});
