// The completed-reset banner (sign-in audit, founder decision 13 November 2026). While a
// reset has completed but not been re-enrolled, every signed-in screen says so and offers
// "This wasn't me — close re-enrolment". Closing needs a fresh "confirm it's you": a
// step_up_required refusal shows the confirmation, and once confirmed the close is sent
// again without another tap. Outcomes are plain words inside a notice, never loose text.
// Rendered with react-dom/server; the controller is driven with a fake fetch.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CompletedResetBanner,
  createCloseReenrolment,
  createCompletedResetBanner,
} from "./completed-reset-banner";

function answer(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(statuses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = statuses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

test("the close request posts to the close step with no identity of its own and maps each answer", async () => {
  const { impl, calls } = fakeFetch([
    answer(200, { ok: true }),
    answer(403, { error: "step_up_required" }),
    answer(404, { error: "no_completed_reset" }),
    answer(500),
  ]);
  const close = createCloseReenrolment(impl);
  assert.deepEqual(await close(), { ok: true });
  assert.deepEqual(await close(), { ok: false, reason: "step_up_required" });
  assert.deepEqual(await close(), { ok: false, reason: "nothing_to_close" });
  assert.deepEqual(await close(), { ok: false, reason: "failed" });
  assert.equal(calls[0]!.url, "/api/auth/reset/close");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(calls[0]!.init?.body, "{}");
});

test("a close refused for a stale confirmation asks to confirm, then closes without another tap", async () => {
  const results = [
    { ok: false as const, reason: "step_up_required" as const },
    { ok: true as const },
  ];
  let sent = 0;
  const banner = createCompletedResetBanner({ close: async () => { sent += 1; return results.shift()!; } });
  await banner.close();
  assert.equal(banner.getState().phase, "confirm", "the confirmation is shown");
  await banner.close();
  assert.equal(sent, 1, "no second close while waiting for the confirmation");
  await banner.confirmed();
  assert.equal(sent, 2, "the close is sent again once confirmed");
  assert.equal(banner.getState().phase, "closed");
});

test("nothing to close and a failed request each say so plainly", async () => {
  const nothing = createCompletedResetBanner({ close: async () => ({ ok: false, reason: "nothing_to_close" }) });
  await nothing.close();
  assert.equal(nothing.getState().phase, "nothing");
  const failed = createCompletedResetBanner({ close: async () => ({ ok: false, reason: "failed" }) });
  await failed.close();
  assert.equal(failed.getState().phase, "open");
  assert.match(failed.getState().error ?? "", /couldn't close re-enrolment/i);
});

test("the banner names when the reset finished and when re-enrolment closes, inside a notice", () => {
  const markup = renderToStaticMarkup(
    <CompletedResetBanner
      completedAt="2026-11-13T03:00:00.000Z"
      reenrolUntil="2026-11-20T03:00:00.000Z"
      timeZone="Australia/Sydney"
      passkey={true}
      authenticator={false}
    />,
  );
  const words = text(markup);
  assert.match(words, /Your account reset finished on 13 Nov 2026/);
  assert.match(words, /Until 20 Nov 2026/);
  assert.match(words, /anyone who can read your email can use this reset to set up a new passkey/i);
  assert.match(words, /This wasn't me — close re-enrolment/);
  assert.match(markup, /class="wh-page"/, "on the page grid");
  assert.match(markup, /wh-notice/, "inside a notice, never loose on the page");
});
