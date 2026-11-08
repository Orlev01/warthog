// E11-S09 — client release posting (`src/client/vault/release.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// here fails until the implementation lands. These pin BEHAVIOUR (what postRelease
// DOES with a URL, a request body, a response status, storage and logs), never the
// source text of the module.
//
// Design §4.2 "Release": on approval, after step-up, the browser decrypts the
// high-tier value or card with the vault key and posts it over TLS to
// `/api/approvals/:id/release`. The server holds it ONLY in the in-memory release
// store (keyed server-side by the session connection — never by a value from the
// client), never writing it to the database, logs or metrics; the agent collects
// it once (`collect_release`). This module is the CLIENT half of that hand-over.
//
// ── The contract these tests define (the tester fixes the seam the builder fills) ──
//
//   postRelease(approvalId, value) -> Promise<void>
//     approvalId: the pending approval's id (the `approval_id` the server handed the
//                 agent; it goes into the release URL path).
//     value:      the ALREADY-DECRYPTED high-tier value or card detail, as a single
//                 string (the release store holds one `value: string`).
//     • POSTs the value to `/api/approvals/<approvalId>/release` over the
//       authenticated session (same-origin → the session cookie rides along; the
//       value travels in the request BODY, never the URL);
//     • RESOLVES on a 2xx response;
//     • REJECTS with a plain-English Error message on a non-2xx response, and never
//       resolves silently when the request itself throws (offline);
//     • retains the value only for the in-flight request — it is never written to
//       client storage (local/session) or to the console/logs, and no value lingers
//       to leak into a later call.
//
// postRelease is browser code: it reaches the global `fetch`. These tests drive it
// with a recording FAKE installed on `globalThis.fetch` for the duration of the
// call (restored after), the canonical way to exercise browser fetch code without a
// network. The module is callable with exactly `(approvalId, value)` — production
// mounts it with no injected seam — so the fake must be reachable through the
// global; any optional seam the builder adds is expected to default to it.
//
// Pure client unit tests: a faked `fetch` only, no real network, no DOM, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";

import { postRelease, ReleaseRejectedError } from "./release";

// --- representative plaintexts (distinct, no JSON-special characters) --------
//
// A long distinctive high-tier marker so the no-leak checks are meaningful, and a
// card number WITH spaces so we prove the client ships it through unmangled.
const HIGH_TIER_VALUE = "PA1234567DONOTLEAKmarker7f3a9c2bQ8";
const CARD_NUMBER = "4111 1111 1111 1111";
const APPROVAL_ID = "3f1c2d4e-5a6b-7c8d-9e0f-112233445566";

// Two clearly-distinct (non-substring) releases, to prove nothing is retained
// across calls.
const ID_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ID_B = "bbbbbbbb-0000-0000-0000-000000000002";
const VALUE_A = "FIRST-release-value-alpha-0001";
const VALUE_B = "SECOND-release-value-bravo-0002";

// --- a recording fake `fetch` ----------------------------------------------

interface RecordedRequest {
  url: string;
  method: string;
  bodyText: string;
  credentials: RequestCredentials | undefined;
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;

function makeFetch(responder: Responder): {
  fetchImpl: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url: string;
    let method: string;
    let bodyText: string;
    let credentials: RequestCredentials | undefined;

    if (typeof Request !== "undefined" && input instanceof Request) {
      url = input.url;
      method = input.method;
      bodyText = await input.clone().text();
      credentials = input.credentials;
    } else {
      url = typeof input === "string" ? input : String(input);
      method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body;
      bodyText = typeof body === "string" ? body : body == null ? "" : String(body);
      credentials = init?.credentials;
    }

    const record: RecordedRequest = { url, method, bodyText, credentials };
    calls.push(record);
    return await responder(record);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

// Install the fake on the global for the duration of `run`, then restore — robust
// whether the impl reaches `fetch` directly or through a call-time default wrapper.
async function withFetch<T>(
  responder: Responder,
  run: (calls: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const { fetchImpl, calls } = makeFetch(responder);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// A 2xx response (204 carries no body).
function accepted(status: number): Response {
  return new Response(status === 204 ? null : "ok", { status });
}

// ---------------------------------------------------------------------------
// AC: postRelease sends the value to /api/approvals/<id>/release (value in body)
// ---------------------------------------------------------------------------

test("posts the value to the approval's release path by POST, value in the body not the URL", async () => {
  await withFetch(
    () => accepted(204),
    async (calls) => {
      await postRelease(APPROVAL_ID, HIGH_TIER_VALUE);

      assert.equal(calls.length, 1, "exactly one request is issued");
      const req = calls[0]!;
      assert.ok(
        req.url.includes(`/api/approvals/${APPROVAL_ID}/release`),
        `expected the release path, saw: ${req.url}`,
      );
      assert.equal(req.method, "POST", "the release is a POST");
      assert.ok(
        req.bodyText.includes(HIGH_TIER_VALUE),
        "the decrypted value travels in the request body",
      );
      assert.ok(
        !req.url.includes(HIGH_TIER_VALUE),
        "the value must never appear in the URL (URLs get logged)",
      );
    },
  );
});

test("a card number release ships the digits and spaces through intact in the body", async () => {
  await withFetch(
    () => accepted(200),
    async (calls) => {
      await postRelease(APPROVAL_ID, CARD_NUMBER);

      assert.equal(calls.length, 1);
      const req = calls[0]!;
      assert.ok(
        req.url.includes(`/api/approvals/${APPROVAL_ID}/release`),
        `expected the release path, saw: ${req.url}`,
      );
      assert.ok(
        req.bodyText.includes(CARD_NUMBER),
        "the card number must travel byte-for-byte in the body, unmangled",
      );
      assert.ok(!req.url.includes("4111"), "no part of the card number may leak into the URL");
    },
  );
});

test("sends over the authenticated session — it never disables the session cookie", async () => {
  await withFetch(
    () => accepted(204),
    async (calls) => {
      await postRelease(APPROVAL_ID, HIGH_TIER_VALUE);

      const cred = calls[0]!.credentials;
      // Same-origin fetch sends the cookie by default (`undefined`/"same-origin");
      // "include" is fine too. Only an explicit "omit" would break the session.
      assert.ok(
        cred === undefined || cred !== "omit",
        `the release must ride the authenticated session, not omit it; saw credentials=${String(cred)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// AC: resolves on a 2xx
// ---------------------------------------------------------------------------

test("resolves when the server accepts the release (any 2xx)", async () => {
  let status = 200;
  await withFetch(
    () => accepted(status),
    async (calls) => {
      for (status of [200, 201, 204]) {
        await assert.doesNotReject(
          postRelease(APPROVAL_ID, HIGH_TIER_VALUE),
          `postRelease must resolve on a ${status}`,
        );
      }
      assert.equal(calls.length, 3, "each accepted release still issued its request");
    },
  );
});

// ---------------------------------------------------------------------------
// AC: rejects with a plain message on a non-2xx (and the message never leaks the value)
// ---------------------------------------------------------------------------

test("rejects with a plain, non-empty message that never leaks the value (any non-2xx)", async () => {
  let status = 400;
  await withFetch(
    () => new Response("the approval could not be released", { status }),
    async (calls) => {
      for (status of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
        await assert.rejects(
          postRelease(APPROVAL_ID, HIGH_TIER_VALUE),
          (err: unknown) => {
            assert.ok(err instanceof Error, `a ${status} must reject with an Error`);
            assert.ok(
              typeof err.message === "string" && err.message.length > 0,
              `a ${status} rejection needs a plain, non-empty message`,
            );
            assert.ok(
              !err.message.includes(HIGH_TIER_VALUE),
              `the error message must not leak the released value (${status})`,
            );
            return true;
          },
        );
      }
      assert.equal(calls.length, 9, "each refused release still issued its request");
    },
  );
});

// ---------------------------------------------------------------------------
// AC (never fail silently): a thrown fetch surfaces as a rejection, not a resolve
// ---------------------------------------------------------------------------

test("never fails silently: a thrown fetch (offline) rejects rather than resolving", async () => {
  await withFetch(
    () => {
      throw new TypeError("network request failed");
    },
    async (calls) => {
      await assert.rejects(
        postRelease(APPROVAL_ID, HIGH_TIER_VALUE),
        (err: unknown) => {
          assert.ok(
            err instanceof Error,
            "a network failure must surface as an Error, never a silent resolve",
          );
          assert.ok(
            !(err as Error).message.includes(HIGH_TIER_VALUE),
            "a surfaced network error must not leak the value",
          );
          return true;
        },
      );
      assert.equal(calls.length, 1, "the request was attempted");
    },
  );
});

// ---------------------------------------------------------------------------
// AC: the value is never written to client storage or logs; only the in-flight
// request carries it.
// ---------------------------------------------------------------------------

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function recordingStorage(sink: string[]): Storage {
  return {
    length: 0,
    clear() {},
    getItem() {
      return null;
    },
    key() {
      return null;
    },
    removeItem() {},
    setItem(k: string, v: string) {
      sink.push(`${k}=${v}`);
    },
  } as unknown as Storage;
}

test("does not write the released value to client storage or the console — only the request carries it", async () => {
  const logged: string[] = [];
  const stored: string[] = [];

  // Capture every console channel and both web-storage globals for the duration
  // of the call; the value must reach NONE of them (scoped narrowly to this one
  // postRelease invocation), only the in-flight request body.
  const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const realConsole: Record<string, unknown> = {};
  for (const m of consoleMethods) {
    realConsole[m] = (console as unknown as Record<string, unknown>)[m];
    (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args) => {
      logged.push(stringifyArgs(args));
    };
  }

  const realLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const realSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: recordingStorage(stored),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: recordingStorage(stored),
    configurable: true,
    writable: true,
  });

  try {
    await withFetch(
      () => accepted(204),
      async (calls) => {
        await postRelease(APPROVAL_ID, HIGH_TIER_VALUE);

        assert.equal(calls.length, 1, "exactly one in-flight request");
        assert.ok(
          calls[0]!.bodyText.includes(HIGH_TIER_VALUE),
          "the in-flight request body carries the value (it has to go somewhere)",
        );
      },
    );
  } finally {
    for (const m of consoleMethods) {
      (console as unknown as Record<string, unknown>)[m] = realConsole[m];
    }
    if (realLocal) Object.defineProperty(globalThis, "localStorage", realLocal);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (realSession) Object.defineProperty(globalThis, "sessionStorage", realSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }

  for (const line of logged) {
    assert.ok(!line.includes(HIGH_TIER_VALUE), `the value must never be logged; saw: ${line}`);
  }
  for (const write of stored) {
    assert.ok(
      !write.includes(HIGH_TIER_VALUE),
      `the value must never be written to client storage; saw: ${write}`,
    );
  }
});

test("retains nothing across calls: each release carries only its own value and id", async () => {
  await withFetch(
    () => accepted(204),
    async (calls) => {
      await postRelease(ID_A, VALUE_A);
      await postRelease(ID_B, VALUE_B);

      assert.equal(calls.length, 2, "two independent releases, two requests");

      const first = calls[0]!;
      assert.ok(first.url.includes(ID_A), "first request targets approval A");
      assert.ok(first.bodyText.includes(VALUE_A), "first request carries value A");
      assert.ok(!first.bodyText.includes(VALUE_B), "first request must not carry value B");

      const second = calls[1]!;
      assert.ok(second.url.includes(ID_B), "second request targets approval B");
      assert.ok(second.bodyText.includes(VALUE_B), "second request carries value B");
      assert.ok(
        !second.bodyText.includes(VALUE_A),
        "no value from the first release may linger into the second",
      );
      assert.ok(!second.url.includes(ID_A), "the second request must not reuse the first id");
    },
  );
});

// ---------------------------------------------------------------------------
// Review fix C7: a refused release says WHY (the server's stable error code), so the
// inbox can offer the right next step — e.g. "Confirm it's you" when the step-up has
// lapsed — instead of a generic "try again" that can never succeed.
// ---------------------------------------------------------------------------

test("a refused release carries the server's error code (and never the value)", async () => {
  await withFetch(
    () => new Response(JSON.stringify({ error: "step_up_required" }), { status: 403 }),
    async () => {
      await assert.rejects(postRelease(APPROVAL_ID, HIGH_TIER_VALUE), (err: unknown) => {
        assert.ok(err instanceof ReleaseRejectedError, "a refusal is a typed ReleaseRejectedError");
        assert.equal(err.code, "step_up_required", "carrying the server's error code");
        assert.equal(err.status, 403, "and the status");
        assert.ok(!err.message.includes(HIGH_TIER_VALUE), "never the released value");
        return true;
      });
    },
  );
  await withFetch(
    () => new Response("not json", { status: 500 }),
    async () => {
      await assert.rejects(postRelease(APPROVAL_ID, HIGH_TIER_VALUE), (err: unknown) => {
        assert.ok(err instanceof ReleaseRejectedError && err.code === null, "an unreadable body has no code");
        return true;
      });
    },
  );
});
