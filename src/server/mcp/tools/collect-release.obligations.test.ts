// E07-S15 — the `collect_release` core tool, the obligation acceptance criteria
// (`src/server/mcp/tools/collect-release.ts` + its validation / no-secret boundaries,
// design §4.2/§6.2; INV-102 validate-and-parameterize-input, INV-103 secrets-from-env;
// project rule "a released value lives only in the in-memory release store" and the
// redaction rule "never log/store/return a secret in plain text" — logs/metrics side).
//
// RED-first: `./collect-release` does not exist yet, so importing
// `createCollectReleaseTool` / `releaseKeyFor` throws and every test here fails until the
// builder writes the module. That absence IS the point of test-first; do NOT implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. The pinned tool contract is documented in
// the sibling `collect-release.test.ts`; this file depends on the same
// `createCollectReleaseTool(deps)` factory, `releaseKeyFor(connection)` key scheme and
// `handle(input, connection)` surface.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • the handler rejects a malformed / oversized / mis-shaped input with a 4xx
//       HttpError BEFORE the release store is touched (its put/collect are landmines that
//       throw if reached); and
//     • collect_release performs NO database access — its value comes solely from the
//       in-memory release store (there is no query) — so untrusted input never reaches a
//       query. The one input field (`reason`) is validated at the boundary and then used
//       only as data: a SQL-shaped reason neither errors nor alters the collected value.
//   AC [obligation:secrets-from-env] (INV-103) — the tool runs purely from its injected
//     release-store seam and reads no `process.env`, so a decoy env secret never lands in
//     the returned result; config flows in, never baked in.
//   AC (redaction / logs) — collecting a value never writes it to the console
//     (logs/metrics) in the clear; the value is handed to the agent through the result
//     only.
//
// No test constructs a database: collect_release needs none. Tests never touch the
// network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createCollectReleaseTool, releaseKeyFor } from "./collect-release";
import { createReleaseStore } from "../../crypto/release-store";
import type { ReleaseStore } from "../../crypto/release-store";
import { HttpError } from "../../http/validate";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";

interface CollectResult {
  readonly status: string;
  readonly value?: string;
}

const is4xx = (err: unknown): boolean =>
  err instanceof HttpError && err.status >= 400 && err.status < 500;

function fixedClock(): Clock {
  const frozen = new Date("2026-11-15T12:00:00.000Z").getTime();
  return { now: () => new Date(frozen) };
}

function connectionFor(userId: string): AgentConnection {
  const connectionId = randomUUID();
  return { userId, connectionId, agentId: connectionId, active: true };
}

// A release store whose every method throws: if validation is skipped and the handler
// reaches the store for an invalid input, the thrown error is a plain Error (not a 4xx
// HttpError) and the `is4xx` predicate fails the test.
function landmineStore(): ReleaseStore {
  return {
    put(): void {
      throw new Error("releaseStore.put must not run for invalid input");
    },
    collect(): string | undefined {
      throw new Error("releaseStore.collect must not run for invalid input");
    },
    size(): number {
      throw new Error("releaseStore.size must not run for invalid input");
    },
  };
}

// Redirect every console channel into an array for the duration of a call, so a test can
// assert the released value was never written to logs/metrics. Restores on teardown.
function captureConsole(): { lines: string[]; restore: () => void } {
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const sink = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals = new Map<string, ((...args: unknown[]) => void) | undefined>();
  const lines: string[] = [];
  for (const m of methods) {
    originals.set(m, sink[m]);
    sink[m] = (...args: unknown[]): void => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return {
    lines,
    restore(): void {
      for (const m of methods) {
        const original = originals.get(m);
        if (original) sink[m] = original;
      }
    },
  };
}

// ===========================================================================
// AC [validate-and-parameterize-input] — a mis-shaped input is rejected with a 4xx BEFORE
// the store is touched. The store is a LANDMINE: if the handler reaches it before
// validating, the rejection is no longer a 4xx HttpError and the test fails.
// ===========================================================================

test("collect_release rejects a mis-shaped input with a 4xx, before the store is touched", async () => {
  const tool = createCollectReleaseTool({ releaseStore: landmineStore() });
  const conn = connectionFor("validate-person");

  // A bare scalar is not the tool's object input.
  await assert.rejects(() => tool.handle(42, conn), (err: unknown) => is4xx(err), "a number input is a 4xx");
  await assert.rejects(
    () => tool.handle("collect please", conn),
    (err: unknown) => is4xx(err),
    "a string input is a 4xx",
  );
  // A wrong-typed `reason` (it is a string field).
  await assert.rejects(
    () => tool.handle({ reason: 999 }, conn),
    (err: unknown) => is4xx(err),
    "a non-string reason is a 4xx",
  );
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a grossly OVERSIZED reason is refused with a 4xx
// before the store is touched (the field is capped at the boundary).
// ===========================================================================

test("collect_release rejects an OVERSIZED reason with a 4xx before the store is touched", async () => {
  const tool = createCollectReleaseTool({ releaseStore: landmineStore() });
  await assert.rejects(
    () => tool.handle({ reason: "x".repeat(100_000) }, connectionFor("oversize-person")),
    (err: unknown) => is4xx(err),
    "an oversized reason must be rejected with a 4xx HttpError",
  );
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a well-formed input is accepted (read from the
// store), and the only input field (`reason`) is treated purely as DATA: a SQL-shaped
// reason neither errors nor changes the collected value. collect_release performs NO
// database access (the value's sole source is the in-memory store), so there is no query
// for a probe to alter — the obligation reduces to "validate at the boundary, use input
// only as data", both pinned here.
// ===========================================================================

test("a SQL-shaped reason is treated as inert data and does not change the collected value", async () => {
  const store = createReleaseStore(fixedClock());
  const conn = connectionFor("sql-probe");
  const VALUE = "tax-file-number-123456789";
  store.put(releaseKeyFor(conn), VALUE);

  const tool = createCollectReleaseTool({ releaseStore: store });

  // A reason shaped like a classic injection. It is only ever a plain string the tool
  // carries as data; nothing is concatenated into SQL (there is no SQL).
  const result = (await tool.handle(
    { reason: "x'); DROP TABLE releases; --" },
    conn,
  )) as CollectResult;

  assert.equal(result.status, "collected", "a SQL-shaped reason is accepted as data; the value still collects");
  assert.equal(result.value, VALUE, "the SQL-shaped reason did not alter or corrupt the collected value");
});

test("collect_release accepts a small, well-formed input and reads the store (not a 4xx)", async () => {
  const store = createReleaseStore(fixedClock());
  const conn = connectionFor("accepted");
  store.put(releaseKeyFor(conn), "a-released-value");

  const result = (await createCollectReleaseTool({ releaseStore: store }).handle(
    { reason: "ok" },
    conn,
  )) as CollectResult;
  assert.equal(result.status, "collected", "a well-formed input is read, not rejected as a 4xx");
});

// ===========================================================================
// AC [secrets-from-env] — the tool reads no process.env: a decoy env secret never appears
// in the returned result. The tool runs purely from its injected store seam.
// ===========================================================================

test("collect_release reads no process.env: a decoy env secret never appears in the result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  try {
    const store = createReleaseStore(fixedClock());
    const conn = connectionFor("secrets-env");
    store.put(releaseKeyFor(conn), "the-only-value-that-should-return");

    const result = await createCollectReleaseTool({ releaseStore: store }).handle({ reason: "go" }, conn);
    assert.ok(
      !JSON.stringify(result ?? {}).includes(DECOY),
      "no ambient env value is folded into the returned result",
    );
  } finally {
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// AC (redaction / logs) — collecting a release never writes the value to the console
// (logs/metrics) in the clear. The value reaches the agent only through the returned
// result; it must never appear in a log line.
// ===========================================================================

test("collect_release never writes the released value to logs/metrics (console)", async () => {
  const store = createReleaseStore(fixedClock());
  const conn = connectionFor("log-canary");
  // A unique canary with characters outside hex/base64, so any appearance in output could
  // only be the raw value leaking.
  const value = `release-canary ∂ ${randomUUID()} !!`;
  store.put(releaseKeyFor(conn), value);

  const tool = createCollectReleaseTool({ releaseStore: store });
  const capture = captureConsole();
  let got: CollectResult;
  try {
    got = (await tool.handle({ reason: "collect" }, conn)) as CollectResult;
  } finally {
    capture.restore();
  }

  assert.equal(got.value, value, "the value still round-trips to the agent through the result");
  for (const line of capture.lines) {
    assert.ok(
      !line.includes(value),
      "the released value must never be written to logs/metrics in the clear",
    );
  }
});
