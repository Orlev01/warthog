import { test } from "node:test";
import assert from "node:assert/strict";
import { createCimdFetcher } from "./clients";
import { fixedClock } from "../seams/clock";

test("CIMD metadata evicts old entries instead of retaining arbitrary public client URLs forever", async () => {
  const calls = new Map<string, number>();
  const fetcher = createCimdFetcher({ clock: fixedClock(new Date("2026-11-09T12:00:00Z")),
    lookup: async () => ["8.8.8.8"], fetch: async (input) => {
      const url = String(input); calls.set(url, (calls.get(url) ?? 0) + 1);
      return Response.json({ client_id: url, redirect_uris: ["https://client.example.test/callback"] });
    } });
  const url = (n: number) => "https://client.example.test/metadata/" + n;
  for (let i = 0; i < 129; i++) await fetcher(url(i));
  await fetcher(url(128));
  assert.equal(calls.get(url(128)), 1, "the most recent entry still avoids another outbound request");
  await fetcher(url(0));
  assert.equal(calls.get(url(0)), 2, "the oldest URL is no longer retained beyond the bounded cache");
});

test("CIMD refuses oversized client identifiers before any DNS or HTTP request", async () => {
  let contacted = 0;
  const fetcher = createCimdFetcher({ clock: fixedClock(new Date()),
    lookup: async () => { contacted++; return ["8.8.8.8"]; },
    fetch: async () => { contacted++; return Response.json({}); } });
  await assert.rejects(fetcher("https://client.example.test/" + "a".repeat(2048)), /client_id/);
  assert.equal(contacted, 0);
});

test("CIMD limits simultaneous outbound lookups without queueing unbounded work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher = createCimdFetcher({ clock: fixedClock(new Date()), lookup: async () => ["8.8.8.8"],
    fetch: async () => { calls++; if (calls > 16) throw new Error("unexpected outbound request"); await gate; return Response.json({}); } });
  const pending = Array.from({ length: 16 }, (_, n) => fetcher("https://client.example.test/" + n));
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(fetcher("https://client.example.test/excess"), /too many.*fetch/i);
    assert.equal(calls, 16);
  } finally { release(); await Promise.all(pending); }
  await assert.doesNotReject(fetcher("https://client.example.test/0"));
});

test("CIMD cancels an oversized declared body and never trusts error responses as metadata", async () => {
  for (const status of [200, 503]) {
    let cancelled = false;
    const fetcher = createCimdFetcher({ clock: fixedClock(new Date()), lookup: async () => ["8.8.8.8"],
      fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status, headers: status === 200 ? { "content-length": "65537" } : {} }) });
    await assert.rejects(fetcher("https://client.example.test/metadata"), status === 200 ? /size cap/ : /response/);
    assert.equal(cancelled, true);
  }
});

test("the CIMD deadline also ends a stalled initial DNS lookup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishLookup!: (addresses: string[]) => void;
  const lookup = new Promise<string[]>((resolve) => { finishLookup = resolve; });
  let outcome = "pending";
  const fetcher = createCimdFetcher({ clock: fixedClock(new Date()), lookup: async () => lookup,
    fetch: async () => Response.json({}) });
  const pending = fetcher("https://slow.example.test/metadata").then(
    () => { outcome = "resolved"; }, () => { outcome = "rejected"; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5001);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(outcome, "rejected");
  } finally { finishLookup(["8.8.8.8"]); await pending; }
});
