// Operator fix (found by the real-browser E2E): Next compiles route handlers and pages into
// separate module graphs, so a module-level `export const x = create()` exists once PER GRAPH —
// the sign-up route wrote its email code to one dev outbox while /dev/outbox read another, empty
// one. Process-wide state lives on globalThis under a registered symbol, so every copy of a
// module resolves the same instance.
import { test } from "node:test";
import assert from "node:assert/strict";

import { processSingleton } from "./process-singleton";

test("the same name always yields the same instance, created once", () => {
  let created = 0;
  const make = () => ({ id: ++created });
  const a = processSingleton("test.same", make);
  const b = processSingleton("test.same", make);
  assert.equal(a, b);
  assert.equal(created, 1);
});

test("different names yield different instances", () => {
  assert.notEqual(processSingleton("test.one", () => ({})), processSingleton("test.two", () => ({})));
});

test("a second copy of a module (a separate factory closure) resolves the existing instance via globalThis", () => {
  const first = processSingleton("test.copies", () => new Map<string, number>());
  first.set("k", 1);
  // A duplicated module graph re-runs its own top-level code with its own factory.
  const second = processSingleton("test.copies", () => new Map<string, number>());
  assert.equal(second.get("k"), 1);
  assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for("warthog.test.copies")], first);
});
