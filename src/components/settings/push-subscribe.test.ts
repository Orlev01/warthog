// Review fix G5 — subscribing this browser for Web Push (src/components/settings/push-subscribe.ts).
//
// The first "Register this device" tap always failed: navigator.serviceWorker.register()
// resolves while the new worker is still installing (registration.active === null) and
// PushManager.subscribe() rejects with no active worker, so the person saw "We couldn't
// set this device up" and only a second tap worked. The ceremony now asks for permission
// first (inside the tap's user activation — Safari/iOS require it), registers the
// worker, WAITS for `serviceWorker.ready` (an active worker), and reuses an existing
// subscription instead of replacing it.
//
// The helper takes ServiceWorkerContainer / Notification look-alikes, so it is driven
// here with fakes that reproduce the browser's real ordering rules.

import { test } from "node:test";
import assert from "node:assert/strict";

import { subscribeThisBrowser, endpointFingerprint } from "./push-subscribe";

type FakeSub = { endpoint: string; toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } } };

function fakeSubscription(endpoint: string): FakeSub {
  return { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: "p256", auth: "auth" } }) };
}

// A container whose worker becomes active only one tick AFTER register() resolves —
// exactly when `ready` resolves — and whose subscribe() rejects while not active.
function fakeContainer(opts: { existing?: FakeSub } = {}) {
  const log: string[] = [];
  const registration = {
    active: null as object | null,
    pushManager: {
      async getSubscription() {
        log.push("getSubscription");
        return opts.existing ?? null;
      },
      async subscribe(_options: unknown) {
        log.push("subscribe");
        if (!registration.active) throw new DOMException("no active Service Worker", "AbortError");
        return fakeSubscription("https://push.example/new");
      },
    },
  };
  let resolveReady: (r: typeof registration) => void = () => {};
  const ready = new Promise<typeof registration>((resolve) => {
    resolveReady = resolve;
  });
  const container = {
    async register(url: string) {
      log.push(`register ${url}`);
      setTimeout(() => {
        registration.active = {};
        resolveReady(registration);
      }, 1);
      return registration;
    },
    ready,
  };
  return { container, log };
}

function fakeNotification(answer: NotificationPermission) {
  const log: string[] = [];
  return {
    log,
    notification: {
      async requestPermission() {
        log.push("requestPermission");
        return answer;
      },
    },
  };
}

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

test("the first tap succeeds: subscribe runs only after the worker is ready (active)", async () => {
  const { container, log } = fakeContainer();
  const { notification } = fakeNotification("granted");
  const outcome = await subscribeThisBrowser({ container, notification, vapidPublicKey: KEY });
  assert.deepEqual(outcome, {
    ok: true,
    subscription: { endpoint: "https://push.example/new", keys: { p256dh: "p256", auth: "auth" } },
  });
  assert.deepEqual(log, ["register /sw.js", "getSubscription", "subscribe"]);
});

test("permission is asked before anything else, and a refusal subscribes nothing", async () => {
  const { container, log } = fakeContainer();
  const n = fakeNotification("denied");
  const outcome = await subscribeThisBrowser({ container, notification: n.notification, vapidPublicKey: KEY });
  assert.deepEqual(outcome, { ok: false, reason: "push_denied" });
  assert.deepEqual(n.log, ["requestPermission"]);
  assert.deepEqual(log, [], "the worker is not even registered");
});

test("an existing subscription on this browser is reused, never replaced", async () => {
  const { container, log } = fakeContainer({ existing: fakeSubscription("https://push.example/kept") });
  const { notification } = fakeNotification("granted");
  const outcome = await subscribeThisBrowser({ container, notification, vapidPublicKey: KEY });
  assert.equal(outcome.ok && outcome.subscription.endpoint, "https://push.example/kept");
  assert.ok(!log.includes("subscribe"));
});

test("a browser without service workers, Notification or a key reports push_unavailable", async () => {
  const { container } = fakeContainer();
  const { notification } = fakeNotification("granted");
  assert.deepEqual(await subscribeThisBrowser({ container: undefined, notification, vapidPublicKey: KEY }), {
    ok: false,
    reason: "push_unavailable",
  });
  assert.deepEqual(await subscribeThisBrowser({ container, notification: undefined, vapidPublicKey: KEY }), {
    ok: false,
    reason: "push_unavailable",
  });
  assert.deepEqual(await subscribeThisBrowser({ container, notification, vapidPublicKey: undefined }), {
    ok: false,
    reason: "push_unavailable",
  });
});

test("endpointFingerprint is a stable SHA-256 hex digest that never contains the endpoint", async () => {
  const a = await endpointFingerprint("https://push.example/abc");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await endpointFingerprint("https://push.example/abc"));
  assert.notEqual(a, await endpointFingerprint("https://push.example/abd"));
});
