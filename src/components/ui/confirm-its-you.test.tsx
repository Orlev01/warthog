// Review fix G3 — the reusable inline "Confirm it's you" (step-up) control
// (src/components/ui/confirm-its-you.tsx).
//
// Sensitive actions (export, delete account, removing a passkey, …) are refused once the
// last confirmation is older than 5 minutes, but only the Security screen's passkey
// controls ever offered a way to confirm: everywhere else the person read "re-authenticate
// … then try again" (or "sign out and back in") with no control — a dead end. This module
// is the one shared step-up client: a framework-free controller that runs
//   POST /api/auth/step-up/begin → the OS passkey prompt → POST /api/auth/step-up/finish
// and a thin component any screen can mount.
//
// Behaviour only: the controller is driven with a fake fetch + fake passkey prompt and
// its requests/state asserted; the component is rendered with react-dom/server.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createConfirmItsYou, ConfirmItsYou, confirmItsYouExplanation } from "./confirm-its-you";

type Sent = { url: string; method: string; body: unknown };

function fakeFetch(responses: Record<string, { status: number; body: unknown }>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const r = responses[url] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const OPTIONS = { challenge: "abc", rpId: "warthog.test" };
const ASSERTION = { id: "cred", rawId: "cred", type: "public-key", response: {} };

test("confirm runs begin → passkey prompt → finish and reports confirmed", async () => {
  const { sent, fetch } = fakeFetch({
    "/api/auth/step-up/begin": { status: 200, body: { options: OPTIONS } },
    "/api/auth/step-up/finish": { status: 200, body: { ok: true } },
  });
  const prompted: unknown[] = [];
  const flow = createConfirmItsYou({
    fetch,
    startAuthentication: async (opts) => {
      prompted.push(opts.optionsJSON);
      return ASSERTION as never;
    },
  });

  assert.equal(await flow.confirm(), true);
  assert.deepEqual(sent.map((s) => [s.method, s.url]), [
    ["POST", "/api/auth/step-up/begin"],
    ["POST", "/api/auth/step-up/finish"],
  ]);
  assert.deepEqual(prompted, [OPTIONS], "the passkey prompt gets the server's options verbatim");
  assert.deepEqual(sent[1]!.body, { authenticationResponse: ASSERTION });
  assert.equal(flow.getState().status, "confirmed");
});

test("a cancelled passkey prompt posts nothing to finish and says so in plain words", async () => {
  const { sent, fetch } = fakeFetch({
    "/api/auth/step-up/begin": { status: 200, body: { options: OPTIONS } },
  });
  const flow = createConfirmItsYou({
    fetch,
    startAuthentication: async () => {
      throw new Error("NotAllowedError");
    },
  });
  assert.equal(await flow.confirm(), false);
  assert.equal(sent.length, 1, "finish is never called");
  assert.equal(flow.getState().status, "error");
  assert.match(flow.getState().error ?? "", /cancel/i);
});

test("a refused begin or finish (or no network) is reported, never claimed as confirmed", async () => {
  for (const responses of [
    { "/api/auth/step-up/begin": { status: 401, body: { error: "unauthenticated" } } },
    {
      "/api/auth/step-up/begin": { status: 200, body: { options: OPTIONS } },
      "/api/auth/step-up/finish": { status: 401, body: { error: "invalid_assertion" } },
    },
  ]) {
    const { fetch } = fakeFetch(responses);
    const flow = createConfirmItsYou({ fetch, startAuthentication: async () => ASSERTION as never });
    assert.equal(await flow.confirm(), false);
    assert.equal(flow.getState().status, "error");
    assert.ok(!/invalid_assertion|unauthenticated/.test(flow.getState().error ?? ""), "no raw machine reason");
  }
  const offline = createConfirmItsYou({
    fetch: (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof globalThis.fetch,
    startAuthentication: async () => ASSERTION as never,
  });
  assert.equal(await offline.confirm(), false);
});

test("a second tap while confirming does not start a second ceremony", async () => {
  let begins = 0;
  const fetch = (async (url: string) => {
    if (url.endsWith("/begin")) begins += 1;
    return new Response(JSON.stringify(url.endsWith("/begin") ? { options: OPTIONS } : { ok: true }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const flow = createConfirmItsYou({ fetch, startAuthentication: async () => ASSERTION as never });
  const [a, b] = await Promise.all([flow.confirm(), flow.confirm()]);
  assert.equal(begins, 1);
  assert.equal(a, true);
  assert.equal(b, false);
});

test("onConfirmed is called once after a successful confirm", async () => {
  const { fetch } = fakeFetch({
    "/api/auth/step-up/begin": { status: 200, body: { options: OPTIONS } },
    "/api/auth/step-up/finish": { status: 200, body: { ok: true } },
  });
  let called = 0;
  const flow = createConfirmItsYou({
    fetch,
    startAuthentication: async () => ASSERTION as never,
    onConfirmed: () => {
      called += 1;
    },
  });
  await flow.confirm();
  assert.equal(called, 1);
});

test("the component renders its explanation and a live 'Confirm it's you' button", () => {
  const markup = renderToStaticMarkup(<ConfirmItsYou explanation="Exporting needs a fresh check." />);
  assert.ok(markup.includes("Exporting needs a fresh check."));
  const button = /<button\b([^>]*)>([\s\S]*?)<\/button>/.exec(markup);
  assert.ok(button, "a button is rendered");
  assert.match(button![2].replace(/<[^>]*>/g, ""), /Confirm it(&#x27;|')s you/);
  assert.ok(!/(^|\s)disabled(=""|\s|$)/.test(button![1]), "the button is live");
});

test("authenticator confirmation sends only the code, excludes passkey prompts and notifies once", async () => {
  const { sent, fetch } = fakeFetch({ "/api/auth/step-up/totp": { status: 200, body: { ok: true } } });
  let confirmed = 0;
  const flow = createConfirmItsYou({ fetch, startAuthentication: async () => { throw new Error("must not prompt"); }, onConfirmed: () => { confirmed++; } });
  assert.equal(await flow.confirmWithTotp("050471"), true);
  assert.deepEqual(sent, [{ url: "/api/auth/step-up/totp", method: "POST", body: { totp: "050471" } }]);
  assert.equal(flow.getState().status, "confirmed");
  assert.equal(confirmed, 1);
});

test("authenticator failure and throttling do not confirm, leak response content or duplicate requests", async () => {
  for (const status of [401, 429]) {
    const { sent, fetch } = fakeFetch({ "/api/auth/step-up/totp": { status, body: { error: "private-provider-value" } } });
    const flow = createConfirmItsYou({ fetch, startAuthentication: async () => ASSERTION as never });
    const results = await Promise.all([flow.confirmWithTotp("050471"), flow.confirmWithTotp("050471"), flow.confirm()]);
    assert.deepEqual(results, [false, false, false]);
    assert.equal(sent.length, 1);
    assert.equal(flow.getState().status, "error");
    assert.ok(!flow.getState().error?.includes("private-provider-value"));
    if (status === 429) assert.match(flow.getState().error ?? "", /wait/i);
  }
});

test("the shared confirmation view offers a labelled authenticator alternative", () => {
  const markup = renderToStaticMarkup(<ConfirmItsYou />);
  assert.match(markup, /Authenticator app code/);
  assert.match(markup, /autocomplete="one-time-code"/i);
  assert.match(markup, /Confirm with authenticator app/);
});

// ─── UI/UX pass: only the ways this member can confirm (interaction-16, newcomer-16) ────

test("a member without an authenticator is not offered a code they cannot get", () => {
  const markup = renderToStaticMarkup(<ConfirmItsYou authenticator={false} />);
  assert.doesNotMatch(markup, /Authenticator app code|Confirm with authenticator app|authenticator/i);
  assert.match(markup, /Confirm it(&#x27;|')s you/);
  assert.match(markup, /Use your passkey\./);
});

test("an authenticator-only member gets the code form as the main action and no passkey button", () => {
  const markup = renderToStaticMarkup(<ConfirmItsYou passkey={false} authenticator={true} />);
  assert.match(markup, /Authenticator app code/);
  assert.doesNotMatch(markup, />Confirm it(&#x27;|')s you</);
  assert.match(markup, /<button[^>]*type="submit"[^>]*bg-accent/);
});

test("when the screen doesn't know, both ways stay available (an enrolled factor must be usable)", () => {
  const markup = renderToStaticMarkup(<ConfirmItsYou passkey={false} authenticator={false} />);
  assert.match(markup, /Authenticator app code/);
  assert.match(markup, /Confirm it(&#x27;|')s you/);
  assert.equal(confirmItsYouExplanation({ passkey: true, authenticator: true }), "We need to check it's really you before this goes ahead. Use your passkey or a code from your authenticator app.");
});

test("the code field is short and the controls keep focus while checking (never natively disabled)", () => {
  const markup = renderToStaticMarkup(<ConfirmItsYou />);
  assert.match(markup, /sm:max-w-48/);
  assert.doesNotMatch(markup, /\sdisabled=""/);
});
