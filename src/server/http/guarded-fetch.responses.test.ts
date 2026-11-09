import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createGuardedFetch } from "./guarded-fetch";
import { createGuardedProviderFetch } from "../connectors/provider-mcp";

for (const { method, status } of [
  { method: "DELETE", status: 204 },
  { method: "POST", status: 205 },
  { method: "GET", status: 304 },
  { method: "HEAD", status: 200 },
]) {
  test(`guarded HTTPS preserves ${method} ${status} without a response body`, async (t) => {
    let sent = 0;
    const stub = t.mock.method(https, "request", ((_url: unknown, _options: unknown, receive: (response: unknown) => void) => {
      const outgoing = new EventEmitter() as EventEmitter & { end(): void };
      outgoing.end = () => {
        sent++;
        const incoming = Object.assign(Readable.from([]), {
          statusCode: status, statusMessage: "Upstream", headers: { "x-provider-request": "synthetic-id" },
        });
        receive(incoming);
      };
      return outgoing;
    }) as typeof https.request);
    syncBuiltinESMExports();
    try {
      const response = await createGuardedFetch()(`https://provider.example.test/resource`, { method });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("x-provider-request"), "synthetic-id");
      assert.equal(response.body, null);
      assert.equal(await response.text(), "");
      assert.equal(sent, 1, "a completed upstream mutation is never retried");
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
  });

  test(`provider wrapper preserves ${method} ${status} without a response body`, async () => {
    const request = createGuardedProviderFetch({ resolve: async () => ["1.1.1.1"],
      fetch: async () => new Response(null, { status, headers: { "x-provider-request": "synthetic-id" } }) });
    const response = await request("https://provider.example.test/resource", { method });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("x-provider-request"), "synthetic-id");
  });
}

test("provider wrapper retains a normal response body", async () => {
  const request = createGuardedProviderFetch({ resolve: async () => ["1.1.1.1"],
    fetch: async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }) });
  const response = await request("https://provider.example.test/resource");
  assert.deepEqual(await response.json(), { ok: true });
});
