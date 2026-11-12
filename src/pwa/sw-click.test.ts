// Review fix G6 — tapping a push notification opens the approval, and launching the
// installed app opens Home (public/sw.js notificationclick + public/manifest.webmanifest).
//
// Before this fix the worker only focused whatever window was open (never navigating
// it) or opened "/" — the public marketing page, which offers only Sign up / Sign in —
// although the brief requires a notification that "opens straight onto that approval".
// The manifest's start_url was "/" too, so every launch of the installed app landed on
// the marketing page.
//
// public/sw.js is loaded into a Node vm context with a fake ServiceWorkerGlobalScope
// whose clients record what the worker asks of them (as src/pwa/sw.test.ts does).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW_URL = new URL("../../public/sw.js", import.meta.url);
const MANIFEST_URL = new URL("../../public/manifest.webmanifest", import.meta.url);

type WindowClientFake = {
  url: string;
  navigated: string[];
  focused: number;
  navigate(url: string): Promise<WindowClientFake>;
  focus(): Promise<WindowClientFake>;
};

function windowClient(url: string): WindowClientFake {
  const client: WindowClientFake = {
    url,
    navigated: [],
    focused: 0,
    async navigate(next: string) {
      client.navigated.push(next);
      client.url = next;
      return client;
    },
    async focus() {
      client.focused += 1;
      return client;
    },
  };
  return client;
}

function loadWorker(openWindows: WindowClientFake[]) {
  const listeners: Record<string, Array<(event: unknown) => unknown>> = {};
  const opened: string[] = [];
  const scope: Record<string, unknown> = {
    console,
    addEventListener(type: string, cb: (event: unknown) => unknown) {
      (listeners[type] ??= []).push(cb);
    },
    registration: { showNotification: () => Promise.resolve() },
    clients: {
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
      matchAll: async () => openWindows,
      claim: () => Promise.resolve(),
    },
    skipWaiting: () => Promise.resolve(),
    location: new URL("https://warthog.com.au/sw.js"),
  };
  scope.self = scope;
  vm.createContext(scope);
  vm.runInContext(readFileSync(SW_URL, "utf8"), scope, { filename: "public/sw.js" });
  return { listeners, opened };
}

async function tap(worker: ReturnType<typeof loadWorker>, data: unknown): Promise<void> {
  const waited: Promise<unknown>[] = [];
  let closed = 0;
  for (const handler of worker.listeners.notificationclick ?? []) {
    handler({
      notification: {
        data,
        close() {
          closed += 1;
        },
      },
      waitUntil(p: unknown) {
        waited.push(Promise.resolve(p));
      },
    });
  }
  await Promise.all(waited);
  assert.ok(closed >= 1, "the tapped notification is closed");
}

test("tapping an approval notification with no window open opens that approval in the inbox", async () => {
  const worker = loadWorker([]);
  await tap(worker, { approval_id: "ap_123" });
  assert.deepEqual(worker.opened, ["/inbox?approval=ap_123"]);
});

test("the camel-case approval payload emitted by the production sender opens its approval", async () => {
  const worker = loadWorker([]);
  await tap(worker, { approvalId: "production-approval" });
  assert.deepEqual(worker.opened, ["/inbox?approval=production-approval"]);
});

test("tapping an approval notification navigates an already-open window to it and focuses it", async () => {
  const open = windowClient("https://warthog.com.au/");
  const worker = loadWorker([open]);
  await tap(worker, { approval_id: "ap_456" });
  assert.deepEqual(open.navigated, ["/inbox?approval=ap_456"]);
  assert.equal(open.focused, 1);
  assert.deepEqual(worker.opened, [], "no second window is opened");
});

test("a notification without an approval (e.g. a test push) opens Home, never the marketing page", async () => {
  const worker = loadWorker([]);
  await tap(worker, undefined);
  assert.deepEqual(worker.opened, ["/home"]);
});

test("an approval id is URL-encoded into the link", async () => {
  const worker = loadWorker([]);
  await tap(worker, { approval_id: "a b&c=d" });
  assert.deepEqual(worker.opened, ["/inbox?approval=a%20b%26c%3Dd"]);
});

test("launching the installed app starts at Home", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as { start_url: string; scope: string };
  assert.equal(manifest.start_url, "/home");
  assert.equal(manifest.scope, "/");
});


test("reminder taps open the record's group and anchor, never an arbitrary URL", async () => {
  const recordId = "d7d57ea2-50ea-4ed7-b234-66eb47957b38";
  for (const recordTab of ["subscriptions", "receipts", "renewals"]) {
    const worker = loadWorker([]);
    await tap(worker, { recordId, recordTab, url: "https://evil.test" });
    assert.deepEqual(worker.opened, [`/life-admin?view=life&tab=${recordTab}#record-${recordId}`]);
  }
  for (const data of [{ recordId, recordTab: "__proto__" }, { recordId: "x#secret", recordTab: "receipts" }, { url: "https://evil.test" }]) {
    const worker = loadWorker([]); await tap(worker, data); assert.deepEqual(worker.opened, ["/home"]);
  }
});

test("a sign-in request tap opens the sign-in requests screen and nothing else", async () => {
  const worker = loadWorker([]);
  await tap(worker, { kind: "sign-in-requests", url: "https://evil.test" });
  assert.deepEqual(worker.opened, ["/settings/security/sign-in-requests"]);
  const other = loadWorker([]);
  await tap(other, { kind: "something-else" });
  assert.deepEqual(other.opened, ["/home"]);
});
