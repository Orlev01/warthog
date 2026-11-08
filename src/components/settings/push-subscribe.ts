// Review fix G5 — subscribe THIS browser for Web Push (the ceremony behind the
// Notifications screen's "Register this device"), as a framework-free helper over
// ServiceWorkerContainer / Notification look-alikes so it is testable without a browser.
//
// The order matters, and getting it wrong made every first tap fail:
//   1. Ask for notification permission FIRST, while the tap's user activation is still
//      valid (Safari/iOS only prompt from a user gesture, and waiting for a worker to
//      install can use the activation up). A refusal stops here.
//   2. Register /sw.js, then wait for `container.ready` — it resolves only once a worker
//      is ACTIVE. `register()` resolves while the new worker is still installing, and
//      PushManager.subscribe() rejects ("no active Service Worker") until it is active.
//   3. Reuse this browser's existing subscription when there is one; only otherwise
//      subscribe (a second subscribe would replace the endpoint the server already holds).
//
// Outcomes are machine codes the screen maps to plain words via `?notice=`.

export type PushSubscriptionJson = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

type SubscriptionLike = {
  endpoint?: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string | undefined> };
};

type RegistrationLike = {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<SubscriptionLike>;
  };
};

export interface SubscribeDeps {
  readonly container?: {
    register(url: string): Promise<unknown>;
    readonly ready: Promise<RegistrationLike>;
  };
  readonly notification?: { requestPermission(): Promise<NotificationPermission> };
  readonly vapidPublicKey?: string;
}

export type SubscribeOutcome =
  | { ok: true; subscription: PushSubscriptionJson }
  | { ok: false; reason: "push_unavailable" | "push_denied" | "register_failed" };

const SERVICE_WORKER_URL = "/sw.js";

// Decode a base64url VAPID public key into the bytes PushManager.subscribe wants as its
// applicationServerKey (browsers accept only a BufferSource here, not the string).
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function subscribeThisBrowser(deps: SubscribeDeps): Promise<SubscribeOutcome> {
  const { container, notification, vapidPublicKey } = deps;
  if (!container || !notification || !vapidPublicKey) return { ok: false, reason: "push_unavailable" };

  try {
    const permission = await notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "push_denied" };

    await container.register(SERVICE_WORKER_URL);
    const registration = await container.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));

    const json = subscription.toJSON();
    const endpoint = json.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) return { ok: false, reason: "register_failed" };
    return { ok: true, subscription: { endpoint, keys: { p256dh, auth } } };
  } catch {
    return { ok: false, reason: "register_failed" };
  }
}

// A one-way fingerprint of a push endpoint (SHA-256, hex): the server sends each
// registered device's fingerprint, the browser fingerprints its own current subscription,
// and a match labels that row "This device" — without the endpoint (a capability URL)
// ever being sent to the page.
export async function endpointFingerprint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
