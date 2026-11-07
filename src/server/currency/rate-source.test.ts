// E15-S03 — the daily-reference-rate SOURCE seam
// (`src/server/currency/rate-source.ts`).
//
// RED-first: the module does not exist yet, so importing `./rate-source` throws and every
// test here fails until the builder writes it. That absence IS the point of test-first; do
// NOT implement anything to make these pass — the builder writes the module afterwards.
//
// WHY this exists (task E15-S03; design §8 step 4 + §12): the rate store is fed by a FREE
// official daily-reference source (Frankfurter / ECB reference rates — "no paid tier, no
// plan that bills" per constitution rule 11), reached behind an interface with a dev/test
// FAKE so tests never touch the network (conventions: "External services sit behind
// interfaces with fakes … exchange rates"). The source's base URL comes from CONFIGURATION
// (constitution rule 21 / INV-103: addresses read from config, never baked into code), and
// the source carries NO secret — the provider is free and unauthenticated.
//
// These tests pin BEHAVIOUR (what the seam DOES: the fake returns fixed rates with no
// network call; the real source fetches a URL ROOTED AT the injected base URL and parses the
// upstream daily-rate payload into `DailyRates`; a network error / non-OK status / malformed
// body is REPORTED by a rejection, never swallowed; no Authorization or api-key secret rides
// the request), never the source text of the module — a later rename that preserves behaviour
// must not redden them.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface DailyRates {
//     rateDate: string;                         // the day the set is for, ISO "YYYY-MM-DD"
//     baseCurrency: string;                     // ISO 4217 (the "1 unit of" currency)
//     rates: Readonly<Record<string, number>>;  // quote code -> rate (units of quote per 1 base)
//   }
//
//   interface RateSource {
//     // Fetch the day's reference rates. REJECTS (reports, never swallows) on a network
//     // error, a non-OK HTTP status, or a malformed / invalid body.
//     fetchDailyRates(): Promise<DailyRates>;
//   }
//
//   // The dev/test fake: returns a fixed set with NO network call.
//   fakeRateSource(fixed: DailyRates): RateSource
//
//   // The real source: fetches the day's rates from a free official source whose base URL
//   // is supplied (from `config.exchangeRateBaseUrl`), through an INJECTED fetch
//   // (SSRF-guarded in production, recorded in tests). No secret, no api key.
//   interface FrankfurterRateSourceDeps { baseUrl: string; fetchImpl: typeof fetch }
//   createFrankfurterRateSource(deps: FrankfurterRateSourceDeps): RateSource
//
//   // config.ts (the ONLY reader of process.env) surfaces the base URL from the environment:
//   //   loadConfig(env).exchangeRateBaseUrl  ===  env.EXCHANGE_RATE_BASE_URL
//
// Acceptance criteria → tests:
//   AC2 "The source base URL is read from configuration (never a literal in source), and the
//        dev/test fake returns fixed rates with no network call." — the fake round-trips a
//        fixed set and still works when the global `fetch` is replaced with a throwing stub
//        (proving it makes no network call); the real source fetches a URL ROOTED AT the
//        injected base URL, and swapping the base URL moves the outbound URL with it (so no
//        provider host is hard-coded); the base URL flows from `loadConfig(env)`.
//   AC3 "A fetch failure … is reported, not swallowed." — a network-error rejection, a non-OK
//        HTTP status, a non-JSON body and a body missing required fields each make
//        `fetchDailyRates()` REJECT rather than resolve to a bogus set.
//   AC5 [obligation:secrets-from-env] (INV-103) — the real source carries NO secret: it sends
//        no Authorization / api-key header, reads no `process.env`, and a decoy secret planted
//        in the environment never rides the request.
//
// Tests never touch the network (the fetch seam is always a recorder) and never mutate the
// real environment except the one AC5 test, which restores it in `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { fakeRateSource, createFrankfurterRateSource } from "./rate-source";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased at
// runtime (and test files are excluded from `tsc`), so a rename cannot break these tests; the
// runtime assertions below are what actually gate behaviour.
import type { DailyRates, RateSource, FrankfurterRateSourceDeps } from "./rate-source";
import { loadConfig } from "../config";

// --- fixtures ---------------------------------------------------------------------

// One recorded outbound request: enough to prove WHERE the source dialed and WHAT it carried.
interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

// A recording `fetch` stand-in: records every request and returns whatever `respond` yields.
// No network (conventions: external services sit behind fakes; tests never touch the network).
function recordingFetch(respond: () => Response): {
  fetch: typeof globalThis.fetch;
  requests: SeenRequest[];
} {
  const requests: SeenRequest[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    requests.push({ url, method: String(init?.method ?? "GET"), headers });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch: fn, requests };
}

// A Frankfurter-shaped daily-rate payload (what the free official source returns): a base
// currency, the date the set is for, and a map of quote code -> rate. `amount` is 1 (rates
// are per 1 unit of base).
function frankfurterBody(payload: {
  base: string;
  date: string;
  rates: Record<string, number>;
}): () => Response {
  return () =>
    new Response(JSON.stringify({ amount: 1, base: payload.base, date: payload.date, rates: payload.rates }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const SAMPLE = { base: "EUR", date: "2026-11-06", rates: { AUD: 1.6543, USD: 1.0812, GBP: 0.8721 } };

// Valid DEV-environment key material (generated in-test so the base64 is always well-formed;
// these protect nothing). Lets `loadConfig(env)` succeed so the AC2 config test can read the
// base URL back out of a fully-valid environment.
const HMAC_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

function devEnvWith(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "http://localhost:3000",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_DEV_TOOLS: "1",
    WARTHOG_HMAC_KEY: HMAC_B64,
    WARTHOG_DEV_KEK: KEK_B64,
    ...extra,
  } as NodeJS.ProcessEnv;
}

// Strip trailing slashes so a base URL with or without one still prefixes the dialed URL.
function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// ===========================================================================
// AC2 — the dev/test fake returns fixed rates with NO network call.
// ===========================================================================

test("the dev/test fake returns the fixed rates it was built with", async () => {
  const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.6543, USD: 1.0812 } };
  const source: RateSource = fakeRateSource(fixed);

  const result = await source.fetchDailyRates();

  assert.equal(result.rateDate, "2026-11-06", "the fake reports the fixed date");
  assert.equal(result.baseCurrency, "EUR", "the fake reports the fixed base currency");
  assert.deepEqual(result.rates, { AUD: 1.6543, USD: 1.0812 }, "the fake returns exactly the fixed rate map");
});

test("the dev/test fake makes NO network call (it still works when global fetch throws)", async () => {
  const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.65 } };
  const source: RateSource = fakeRateSource(fixed);

  // Replace the global fetch with a stub that throws if it is ever reached. If the fake
  // dialed the network at all, this would surface as a rejection; it must not.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the dev/test fake must not touch the network");
  }) as typeof globalThis.fetch;
  try {
    const result = await source.fetchDailyRates();
    assert.deepEqual(result.rates, { AUD: 1.65 }, "the fake resolves from its fixed data, not the network");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ===========================================================================
// AC2 — the real source fetches a URL ROOTED AT the injected base URL, and the base URL is
// not a hard-coded literal: swapping it moves the outbound URL with it, and it flows from
// configuration.
// ===========================================================================

test("the real source dials a URL rooted at the injected base URL", async () => {
  const f = recordingFetch(frankfurterBody(SAMPLE));
  const deps: FrankfurterRateSourceDeps = { baseUrl: "https://rates.example.test/v1", fetchImpl: f.fetch };
  const source = createFrankfurterRateSource(deps);

  await source.fetchDailyRates();

  assert.equal(f.requests.length, 1, "the real source issues exactly one upstream request");
  assert.ok(
    f.requests[0]!.url.startsWith("https://rates.example.test/v1"),
    `the dialed URL must be rooted at the injected base URL, got ${f.requests[0]!.url}`,
  );
});

test("the base URL is not hard-coded: swapping it moves the dialed URL (no baked-in host)", async () => {
  const a = recordingFetch(frankfurterBody(SAMPLE));
  const b = recordingFetch(frankfurterBody(SAMPLE));

  await createFrankfurterRateSource({ baseUrl: "https://alpha.example.test", fetchImpl: a.fetch }).fetchDailyRates();
  await createFrankfurterRateSource({ baseUrl: "https://beta.example.test", fetchImpl: b.fetch }).fetchDailyRates();

  const urlA = a.requests[0]!.url;
  const urlB = b.requests[0]!.url;
  assert.ok(urlA.startsWith("https://alpha.example.test"), "source A dials its own base host");
  assert.ok(urlB.startsWith("https://beta.example.test"), "source B dials its own base host");
  assert.notEqual(urlA, urlB, "two different base URLs produce two different dialed URLs");
  assert.ok(!urlA.includes("beta.example.test"), "source A never dials source B's host");
  assert.ok(!urlB.includes("alpha.example.test"), "source B never dials source A's host");
});

test("the real source's base URL flows from loadConfig(env).exchangeRateBaseUrl", async () => {
  // config.ts is the only reader of process.env; the base URL rides in from EXCHANGE_RATE_BASE_URL.
  const cfgA = loadConfig(devEnvWith({ EXCHANGE_RATE_BASE_URL: "https://cfg-a.example.test/v1" }));
  assert.equal(
    cfgA.exchangeRateBaseUrl,
    "https://cfg-a.example.test/v1",
    "config surfaces the base URL read from the environment",
  );

  const fa = recordingFetch(frankfurterBody(SAMPLE));
  await createFrankfurterRateSource({ baseUrl: cfgA.exchangeRateBaseUrl, fetchImpl: fa.fetch }).fetchDailyRates();
  assert.ok(
    fa.requests[0]!.url.startsWith(trimTrailingSlash("https://cfg-a.example.test/v1")),
    "the configured base URL is what the source dials",
  );

  // A different configured value must drive a different dialed URL — proving the URL is read
  // from config each time, never a constant in source.
  const cfgB = loadConfig(devEnvWith({ EXCHANGE_RATE_BASE_URL: "https://cfg-b.example.test/api" }));
  assert.equal(cfgB.exchangeRateBaseUrl, "https://cfg-b.example.test/api", "config surfaces a second base URL too");
  const fb = recordingFetch(frankfurterBody(SAMPLE));
  await createFrankfurterRateSource({ baseUrl: cfgB.exchangeRateBaseUrl, fetchImpl: fb.fetch }).fetchDailyRates();
  assert.ok(
    fb.requests[0]!.url.startsWith(trimTrailingSlash("https://cfg-b.example.test/api")),
    "a changed configuration moves the dialed URL with it",
  );
});

// ===========================================================================
// AC2 — the real source parses the upstream daily-rate payload into DailyRates.
// ===========================================================================

test("the real source parses the upstream payload into DailyRates (date, base, quote->rate)", async () => {
  const f = recordingFetch(frankfurterBody({ base: "EUR", date: "2026-11-06", rates: { AUD: 1.6543, USD: 1.0812 } }));
  const source = createFrankfurterRateSource({ baseUrl: "https://rates.example.test", fetchImpl: f.fetch });

  const result: DailyRates = await source.fetchDailyRates();

  assert.equal(result.rateDate, "2026-11-06", "the upstream `date` becomes the rate date");
  assert.equal(result.baseCurrency, "EUR", "the upstream `base` becomes the base currency");
  assert.equal(result.rates.AUD, 1.6543, "a quote rate is parsed as a number");
  assert.equal(result.rates.USD, 1.0812, "every quote rate is carried through");
});

// ===========================================================================
// AC3 — a fetch failure is REPORTED by a rejection, never swallowed into a bogus set.
// ===========================================================================

test("a network error is reported: the fetch rejection propagates out of fetchDailyRates", async () => {
  const fetchImpl = (() => Promise.reject(new Error("upstream unreachable"))) as typeof globalThis.fetch;
  const source = createFrankfurterRateSource({ baseUrl: "https://rates.example.test", fetchImpl });

  await assert.rejects(
    () => source.fetchDailyRates(),
    "a network error must surface as a rejection, not a silently-empty set",
  );
});

test("a non-OK HTTP status is reported, not treated as rates", async () => {
  const f = recordingFetch(() => new Response("upstream error", { status: 503 }));
  const source = createFrankfurterRateSource({ baseUrl: "https://rates.example.test", fetchImpl: f.fetch });

  await assert.rejects(
    () => source.fetchDailyRates(),
    "a 5xx upstream response must be reported as a failure, never parsed as a rate set",
  );
});

test("a malformed (non-JSON) body is reported, not swallowed", async () => {
  const f = recordingFetch(() => new Response("<html>not json</html>", { status: 200 }));
  const source = createFrankfurterRateSource({ baseUrl: "https://rates.example.test", fetchImpl: f.fetch });

  await assert.rejects(
    () => source.fetchDailyRates(),
    "a body that is not the expected JSON must be reported as a failure",
  );
});

test("a body missing the required daily-rate fields is reported, not swallowed", async () => {
  const f = recordingFetch(() => new Response(JSON.stringify({ hello: "world" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const source = createFrankfurterRateSource({ baseUrl: "https://rates.example.test", fetchImpl: f.fetch });

  await assert.rejects(
    () => source.fetchDailyRates(),
    "a JSON body without base / date / rates must be reported as a failure",
  );
});

// ===========================================================================
// AC5 [obligation:secrets-from-env] — the real source carries no secret: no Authorization /
// api-key header, and a decoy secret planted in the environment never rides the request.
// ===========================================================================

test("the real source sends no Authorization or api-key header (the free source needs none)", async () => {
  const f = recordingFetch(frankfurterBody(SAMPLE));
  const source = createFrankfurterRateSource({ baseUrl: "https://rates.example.test", fetchImpl: f.fetch });

  await source.fetchDailyRates();

  const headers = f.requests[0]!.headers;
  assert.equal(headers.get("authorization"), null, "no Authorization header is attached (free, unauthenticated source)");
  assert.equal(headers.get("x-api-key"), null, "no api-key header is attached");
});

test("the real source reads no process.env: a decoy secret in the environment never rides the request", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  try {
    const f = recordingFetch(frankfurterBody(SAMPLE));
    const source = createFrankfurterRateSource({ baseUrl: "https://rates.example.test", fetchImpl: f.fetch });

    const result = await source.fetchDailyRates();

    // The decoy must appear nowhere the source controls: not in the URL, not in a header, not
    // in the parsed result (the source is built purely from its injected deps).
    const req = f.requests[0]!;
    const headerText = [...req.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    assert.ok(!req.url.includes(DECOY), "no ambient env value is woven into the request URL");
    assert.ok(!headerText.includes(DECOY), "no ambient env value is attached as a request header");
    assert.ok(!JSON.stringify(result).includes(DECOY), "no ambient env value is folded into the parsed result");
  } finally {
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// Keep the documentary types referenced so a drift in their names is noticed at authoring
// time (the imports are erased at runtime; this never executes).
export type __DailyRatesAnchor = DailyRates;
export type __RateSourceAnchor = RateSource;
export type __FrankfurterDepsAnchor = FrankfurterRateSourceDeps;
