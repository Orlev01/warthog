import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startProviderAuthorization,
  finishProviderAuthorization,
  useProviderClient,
  type ProviderState,
} from "./provider-client";

import { providerFixture, settings } from "../../test/provider-mcp";
const issuer = "https://auth.example.test";
test("provider OAuth completes PKCE, binds issuer, discovers and calls tools, and refreshes credentials", async () => {
  const fixture = providerFixture();
  const state: ProviderState = {};
  let saved = 0;
  const url = new URL(
    await startProviderAuthorization(settings, state, fixture.fetch),
  );
  assert.equal(url.searchParams.get("state"), settings.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(state.verifier);
  assert.ok(state.discovery);
  await assert.rejects(() =>
    finishProviderAuthorization(
      { ...settings, code: "code", iss: "https://wrong.example.test" },
      structuredClone(state),
      fixture.fetch,
    ),
  );
  await finishProviderAuthorization(
    { ...settings, code: "code", iss: issuer },
    state,
    fixture.fetch,
  );
  const tools = await useProviderClient(
    settings,
    state,
    fixture.fetch,
    async () => {
      saved++;
    },
    (client) => client.listTools(),
  );
  assert.equal(tools.tools[0]!.name, "search");
  fixture.expire();
  const result = await useProviderClient(
    settings,
    state,
    fixture.fetch,
    async () => {
      saved++;
    },
    (client) =>
      client.callTool({ name: "search", arguments: { query: "test" } }),
  );
  assert.equal(result.content?.[0]?.type, "text");
  assert.equal(fixture.refreshes(), 1);
  assert.ok(saved > 0);
  assert.equal(state.tokens?.access_token, "renewed");
});

test("provider fetch streams SSE and enforces HTTPS and response bounds", async () => {
  const { createGuardedMcpFetch } = await import("./provider-client");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = createGuardedMcpFetch(
    (async () =>
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch,
  );
  const response = await request("https://public.example.test/mcp");
  const reader = response.body!.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    "data: first\n\n",
  );
  await reader.cancel();
  assert.ok(cancelled);
  await assert.rejects(() => request("http://public.example.test/mcp"));
  const large = createGuardedMcpFetch(
    (async () =>
      new Response("oversize", {
        headers: { "content-length": "2000000" },
      })) as typeof fetch,
  );
  await assert.rejects(
    () => large("https://public.example.test/mcp"),
    /too large/,
  );
});
