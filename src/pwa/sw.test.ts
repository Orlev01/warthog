// E05-S04 — the service worker (public/sw.js).
//
// Acceptance criterion under test: "The service worker registers and shows a
// notification for every push payload (the iOS requirement)."
//
// On iOS web push, a push that does NOT result in a user-visible notification
// can cost the site its push permission, so the worker must show a notification
// for EVERY push — including pushes with no data or malformed data. The design
// payload "contains the approval id only (no personal content)".
//
// public/sw.js is a classic service-worker script: it runs in a
// ServiceWorkerGlobalScope where `self` is the global and it attaches handlers
// via self.addEventListener(...). We load it into a Node vm context with a fake
// scope, then dispatch push events and observe self.registration.showNotification.
// The implementation is intentionally absent, so these tests fail (RED) until
// public/sw.js exists and behaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW_URL = new URL("../../public/sw.js", import.meta.url);

interface ShownNotification {
  title: unknown;
  options: unknown;
}

interface LoadedWorker {
  listeners: Record<string, Array<(event: unknown) => unknown>>;
  shown: ShownNotification[];
}

// Load public/sw.js into a fake ServiceWorkerGlobalScope and capture the
// listeners it registers and every showNotification call it makes.
function loadServiceWorker(): LoadedWorker {
  // readFileSync throws ENOENT until public/sw.js is created — that is the RED.
  const code = readFileSync(SW_URL, "utf8");

  const listeners: LoadedWorker["listeners"] = {};
  const shown: ShownNotification[] = [];

  const scope: Record<string, unknown> = {
    console,
    addEventListener(type: string, cb: (event: unknown) => unknown) {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener() {},
    registration: {
      showNotification(title: unknown, options: unknown) {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      openWindow: () => Promise.resolve(null),
      matchAll: () => Promise.resolve([]),
      claim: () => Promise.resolve(),
    },
    skipWaiting: () => Promise.resolve(),
    location: new URL("https://warthog.com.au/sw.js"),
  };
  // In a real worker `self` IS the global scope.
  scope.self = scope;

  vm.createContext(scope);
  vm.runInContext(code, scope, { filename: "public/sw.js" });

  return { listeners, shown };
}

// A fake PushMessageData whose json()/text() behave as configured.
function makeData(raw: string): { json: () => unknown; text: () => string } {
  return {
    json: () => JSON.parse(raw), // throws for malformed raw, like the real API
    text: () => raw,
  };
}

interface PushOptions {
  json?: unknown; // a payload object -> event.data.json() returns it
  raw?: string; // raw bytes that are NOT valid JSON (json() throws)
  empty?: boolean; // no payload at all -> event.data === null
}

// Dispatch a single push event to the worker's push handlers and wait for any
// work it registers via waitUntil, then report what it did.
async function firePush(
  sw: LoadedWorker,
  opts: PushOptions,
): Promise<{ waitUntilCalls: number; thrown: unknown[] }> {
  const handlers = sw.listeners.push ?? [];
  const waited: Promise<unknown>[] = [];
  const thrown: unknown[] = [];

  let data: unknown = null;
  if (!opts.empty) {
    if (opts.raw !== undefined) data = makeData(opts.raw);
    else data = makeData(JSON.stringify(opts.json ?? {}));
  }

  const event = {
    data,
    waitUntil(p: unknown) {
      waited.push(Promise.resolve(p));
    },
  };

  for (const handler of handlers) {
    try {
      handler(event);
    } catch (err) {
      thrown.push(err);
    }
  }
  try {
    await Promise.all(waited);
  } catch (err) {
    thrown.push(err);
  }

  return { waitUntilCalls: waited.length, thrown };
}

test("the worker registers a push event listener", () => {
  const sw = loadServiceWorker();
  const handlers = sw.listeners.push ?? [];
  assert.ok(handlers.length >= 1, "a push listener must be registered");
});

test("a normal approval push shows a notification with a title", async () => {
  const sw = loadServiceWorker();
  await firePush(sw, { json: { approval_id: "ap_test_123" } });
  assert.ok(sw.shown.length >= 1, "a push must show a notification");
  assert.equal(typeof sw.shown[0]!.title, "string", "the notification has a string title");
  assert.ok((sw.shown[0]!.title as string).length > 0, "the title is non-empty");
});

test("a push with no data still shows a notification (iOS requirement)", async () => {
  const sw = loadServiceWorker();
  await firePush(sw, { empty: true });
  assert.ok(sw.shown.length >= 1, "an empty push must still show a notification");
});

test("a push with malformed (non-JSON) data still shows a notification", async () => {
  const sw = loadServiceWorker();
  await firePush(sw, { raw: "<<< not json >>>" });
  assert.ok(
    sw.shown.length >= 1,
    "a push whose payload cannot be parsed must still show a notification",
  );
});

test("every push in a sequence shows exactly one notification (none dropped)", async () => {
  const sw = loadServiceWorker();
  await firePush(sw, { json: { approval_id: "ap_1" } });
  await firePush(sw, { empty: true });
  await firePush(sw, { raw: "not-json" });
  await firePush(sw, { json: { approval_id: "ap_2" } });
  assert.equal(sw.shown.length, 4, "one notification per push, for every push");
});

test("the push handler keeps the worker alive via waitUntil", async () => {
  const sw = loadServiceWorker();
  const { waitUntilCalls } = await firePush(sw, { json: { approval_id: "ap_wait" } });
  assert.ok(
    waitUntilCalls >= 1,
    "the handler passes its notification work to event.waitUntil",
  );
});


test("record reminder push keeps content generic and preserves only its safe destination", async () => {
  const sw = loadServiceWorker();
  const recordId = "d7d57ea2-50ea-4ed7-b234-66eb47957b38";
  await firePush(sw, { json: { recordId, recordTab: "receipts", body: "PRIVATE", url: "https://evil.test" } });
  assert.equal(sw.shown.length, 1);
  const options = JSON.parse(JSON.stringify(sw.shown[0].options));
  assert.deepEqual(options.data, { recordId, recordTab: "receipts" });
  assert.match(options.body, /reminder/i);
  assert.doesNotMatch(JSON.stringify(options), /PRIVATE|evil/);
});
