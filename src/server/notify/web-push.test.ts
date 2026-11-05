// E12-S02 — Web Push VAPID sender (`src/server/notify/web-push.ts`), design §10:
// "Web Push (VAPID via @pushforge/builder) ... payload ≤ 4 KB, contains the
// approval id only (no personal content)."
//
// RED-first: the module does not exist yet, so importing it throws and every test
// here fails until the implementation lands. These tests pin BEHAVIOUR (what the
// sender hands the VAPID builder, what it POSTs, and how it reports failure),
// never the source text of the module.
//
// The contract these tests define for `web-push.ts`:
//   - `createWebPushSender(deps)` builds the real Web Push sender. `deps` are:
//       * `vapid`   — the VAPID config group from `src/server/config.ts`
//                     (`{ subject, publicKey, privateKey }`). The signing key is
//                     READ FROM HERE, never hard-coded in the module.
//       * `fetch`   — the HTTP seam used to POST to a push service (prod injects
//                     the SSRF-guarded fetch; tests inject a recorder). No network.
//       * `buildRequest?` — an OPTIONAL seam over `@pushforge/builder`'s
//                     `buildPushHTTPRequest` (external lib behind a fake, per the
//                     conventions). Defaults to the real builder; tests inject a
//                     fake to inspect the plaintext payload the signer is handed
//                     (the HTTP body is encrypted and cannot be read back).
//   - The returned sender exposes `sendApprovalPush(subscription, approvalId)`,
//     where `subscription` is one device's `{ endpoint, keys: { p256dh, auth } }`
//     (the shape `push-subscriptions` stores). The push payload carries ONLY the
//     approval id — no personal content — and resolves on a 2xx from the push
//     service, REJECTING on any failure so a fallback can run.
//
// Obligation note (this is the single source of truth for why the DB-shaped halves
// of the attached obligations are tested the way they are): this module performs NO
// database access — it signs and POSTs a push. So INV-102's "parameterize every
// query" half is not applicable here (it is enforced test-first in E12-S01, the
// push-subscriptions store). The halves that DO apply are tested below: malformed
// and oversized input are rejected (nothing is sent), and an injection-shaped
// approval id is carried verbatim as opaque data (it alters nothing). INV-103
// (secrets-from-env) is tested as behaviour: the signing key is taken from the
// injected config — two different configured keys sign differently, and a missing
// configured key is reported rather than falling back to any baked-in key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";

import { createWebPushSender } from "./web-push";

// ---------------------------------------------------------------------------
// Test helpers — all local, no network, no Azure, no DB.
// ---------------------------------------------------------------------------

const subtle = webcrypto.subtle;

// A real VAPID application-server private key as a JWK JSON string (what the
// `VAPID_PRIVATE_KEY` config value holds): EC P-256 with x, y and the private d.
// Two calls yield two DISTINCT keys, so a test can prove the signing key is
// config-driven (different config ⇒ different signature) and not hard-coded.
async function vapidPrivateKey(): Promise<string> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = (await subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });
}

// A valid Web Push subscription for one device: an https endpoint plus the two
// browser keys `@pushforge/builder` requires — a 65-byte uncompressed P-256
// public key (`p256dh`) and a 16-byte auth secret, both base64url.
async function validSubscription(host = "push.example.com"): Promise<{
  endpoint: string;
  keys: { p256dh: string; auth: string };
}> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = new Uint8Array(16);
  webcrypto.getRandomValues(auth);
  return {
    endpoint: `https://${host}/send/${randomUUID()}`,
    keys: {
      p256dh: Buffer.from(raw).toString("base64url"),
      auth: Buffer.from(auth).toString("base64url"),
    },
  };
}

// A fetch seam that records every call and returns a configurable result. A send
// to a push service is a single POST; the recorder lets a test assert what was
// POSTed (or that nothing was) without touching the network.
function recordingFetch(result: { ok: boolean; status: number } = { ok: true, status: 201 }) {
  const calls: { input: unknown; init: Record<string, unknown> }[] = [];
  const fetch = async (input: unknown, init: Record<string, unknown>) => {
    calls.push({ input, init });
    return { ok: result.ok, status: result.status, async text() { return ""; } };
  };
  return { calls, fetch };
}

// A fetch seam that fails the way a network error does (the push service is
// unreachable), so a test can prove the failure is reported, not swallowed.
function throwingFetch() {
  const calls: { input: unknown }[] = [];
  const fetch = async (input: unknown) => {
    calls.push({ input });
    throw new Error("network down");
  };
  return { calls, fetch };
}

// A fake over `@pushforge/builder`'s `buildPushHTTPRequest`: it records the
// `{ privateJWK, message, subscription }` it is handed (so a test can inspect the
// PLAINTEXT payload the signer sees — the real HTTP body is encrypted) and returns
// a canned signed request for the sender to POST.
function fakeBuildRequest() {
  const calls: {
    privateJWK: unknown;
    message: { payload: unknown; adminContact?: unknown; options?: unknown };
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  }[] = [];
  const body = new TextEncoder().encode("ENCRYPTED-CIPHERTEXT").buffer;
  const headers = new Headers({
    Authorization: "vapid t=HEAD.PAY.SIG, k=SERVERPUB",
    "Content-Encoding": "aesgcm",
  });
  const buildRequest = async (opts: {
    privateJWK: unknown;
    message: { payload: unknown; adminContact?: unknown; options?: unknown };
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  }) => {
    calls.push(opts);
    return { endpoint: opts.subscription.endpoint, body, headers };
  };
  return { calls, buildRequest, body, headers };
}

// Collect every primitive (leaf) value a JSON-able payload carries. A payload that
// contains ONLY the approval id has exactly `[approvalId]` here — whether the id is
// a bare string or wrapped in a single field — and any extra personal content would
// show up as an extra leaf.
function leafValues(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  if (Array.isArray(value)) return value.flatMap(leafValues);
  return Object.values(value as Record<string, unknown>).flatMap(leafValues);
}

// Read a header by name whether the builder handed back a `Headers` object or a
// plain record (both are valid `buildPushHTTPRequest` return shapes).
function headerValue(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (headers && typeof headers === "object") {
    for (const [key, val] of Object.entries(headers as Record<string, string>)) {
      if (key.toLowerCase() === name.toLowerCase()) return val;
    }
  }
  return null;
}

const SUBJECT = "mailto:no-reply@warthog.com.au";

// ---------------------------------------------------------------------------
// Shape.
// ---------------------------------------------------------------------------

test("createWebPushSender builds a sender exposing sendApprovalPush", async () => {
  const { fetch } = recordingFetch();
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: await vapidPrivateKey() },
    fetch,
  });
  assert.equal(typeof createWebPushSender, "function");
  assert.equal(typeof sender.sendApprovalPush, "function");
});

// ---------------------------------------------------------------------------
// AC: Sending builds a VAPID push whose payload carries ONLY the approval id, and
// POSTs the signed request to the device's endpoint; resolves on a 2xx.
// ---------------------------------------------------------------------------

test("a send hands the signer only the approval id and POSTs the signed request to the endpoint", async () => {
  const privateKey = await vapidPrivateKey();
  const subscription = await validSubscription();
  const approvalId = randomUUID();

  const build = fakeBuildRequest();
  const { calls: fetchCalls, fetch } = recordingFetch({ ok: true, status: 201 });

  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey },
    fetch,
    buildRequest: build.buildRequest,
  });

  // A 2xx from the push service resolves without throwing.
  await sender.sendApprovalPush(subscription, approvalId);

  // The signer was asked for exactly one push.
  assert.equal(build.calls.length, 1, "the push was built once");
  const built = build.calls[0];

  // The payload carries ONLY the approval id — no other (personal) leaf value.
  assert.deepEqual(
    leafValues(JSON.parse(JSON.stringify(built.message.payload))),
    [approvalId],
    "the push payload contains only the approval id",
  );

  // The signing key and the contact subject come from the injected config.
  assert.equal(built.privateJWK, privateKey, "signs with the configured VAPID private key");
  assert.equal(built.message.adminContact, SUBJECT, "VAPID subject comes from config");

  // The device's subscription (endpoint + both keys) is the one passed in.
  assert.equal(built.subscription.endpoint, subscription.endpoint);
  assert.equal(built.subscription.keys.p256dh, subscription.keys.p256dh);
  assert.equal(built.subscription.keys.auth, subscription.keys.auth);

  // Exactly one POST, to the subscription endpoint, carrying the signed VAPID
  // Authorization header and the encrypted body the builder produced.
  assert.equal(fetchCalls.length, 1, "exactly one push was POSTed");
  const { input, init } = fetchCalls[0];
  assert.equal(String(input), subscription.endpoint);
  assert.match(String(init.method), /post/i);
  assert.equal(
    headerValue(init.headers, "Authorization"),
    "vapid t=HEAD.PAY.SIG, k=SERVERPUB",
    "the VAPID Authorization header is sent",
  );
  assert.equal(
    new TextDecoder().decode(init.body as ArrayBuffer),
    "ENCRYPTED-CIPHERTEXT",
    "the encrypted body the signer produced is POSTed",
  );
});

test("the push payload serialises to at most 4 KB", async () => {
  const build = fakeBuildRequest();
  const { fetch } = recordingFetch();
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: await vapidPrivateKey() },
    fetch,
    buildRequest: build.buildRequest,
  });

  await sender.sendApprovalPush(await validSubscription(), randomUUID());

  const serialised = JSON.stringify(build.calls[0].message.payload);
  assert.ok(
    Buffer.byteLength(serialised, "utf8") <= 4096,
    `payload must be at most 4 KB, was ${Buffer.byteLength(serialised, "utf8")} bytes`,
  );
});

// ---------------------------------------------------------------------------
// Obligation (validate-and-parameterize-input, the data half): an injection-shaped
// approval id is carried VERBATIM as opaque payload data — it is never interpreted.
// ---------------------------------------------------------------------------

test("an injection-shaped approval id is carried verbatim as opaque payload data", async () => {
  const build = fakeBuildRequest();
  const { fetch } = recordingFetch();
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: await vapidPrivateKey() },
    fetch,
    buildRequest: build.buildRequest,
  });

  const nastyId = "1'; DROP TABLE approvals; --";
  await sender.sendApprovalPush(await validSubscription(), nastyId);

  // The id round-trips verbatim as the sole payload leaf: data, never a command.
  assert.deepEqual(
    leafValues(JSON.parse(JSON.stringify(build.calls[0].message.payload))),
    [nastyId],
  );
});

// ---------------------------------------------------------------------------
// AC: The VAPID keys are read from configuration, never hard-coded. Two senders
// with DIFFERENT configured keys produce a DIFFERENT real VAPID signing key — which
// could not happen if the key were baked into the module. Uses the REAL
// @pushforge/builder so the signature is genuine.
// ---------------------------------------------------------------------------

test("the VAPID signing key comes from config: different configured keys sign differently", async () => {
  const subscription = await validSubscription();
  const keyA = await vapidPrivateKey();
  const keyB = await vapidPrivateKey();

  const a = recordingFetch();
  const b = recordingFetch();
  const senderA = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: keyA },
    fetch: a.fetch,
  });
  const senderB = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: keyB },
    fetch: b.fetch,
  });

  await senderA.sendApprovalPush(subscription, randomUUID());
  await senderB.sendApprovalPush(subscription, randomUUID());

  const authA = headerValue(a.calls[0].init.headers, "Authorization");
  const authB = headerValue(b.calls[0].init.headers, "Authorization");
  assert.ok(authA && authB, "both sends carry a VAPID Authorization header");

  // A genuine VAPID header: `vapid t=<jwt>, k=<server public key>`.
  const vapidRe = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/;
  const mA = vapidRe.exec(authA!);
  const mB = vapidRe.exec(authB!);
  assert.ok(mA, "sender A produced a well-formed VAPID header");
  assert.ok(mB, "sender B produced a well-formed VAPID header");

  // The `k=` signing-key component differs, because the configured keys differ:
  // proof the key is sourced from config and not a hard-coded constant.
  assert.notEqual(mA![2], mB![2], "a different configured key yields a different signing key");

  // The signed JWT carries the configured subject and the endpoint's origin as
  // audience — both drawn from config / the subscription, not invented.
  const claims = JSON.parse(Buffer.from(mA![1].split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.sub, SUBJECT, "JWT subject is the configured VAPID subject");
  assert.equal(claims.aud, new URL(subscription.endpoint).origin, "JWT audience is the push origin");
});

test("a missing configured VAPID private key is reported, never a hard-coded fallback", async () => {
  const { calls, fetch } = recordingFetch();
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: undefined, privateKey: undefined },
    fetch,
  });

  // No configured key ⇒ the send is rejected (reported), not quietly signed with
  // some baked-in key, and nothing is POSTed.
  const subscription = await validSubscription();
  await assert.rejects(() => sender.sendApprovalPush(subscription, randomUUID()));
  assert.equal(calls.length, 0, "nothing is sent when the signing key is absent");
});

// ---------------------------------------------------------------------------
// AC: A send failure is reported to the caller (not swallowed) so a fallback can run.
// ---------------------------------------------------------------------------

test("a non-2xx from the push service is reported to the caller, not swallowed", async () => {
  const build = fakeBuildRequest();
  const { calls, fetch } = recordingFetch({ ok: false, status: 500 });
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: await vapidPrivateKey() },
    fetch,
    buildRequest: build.buildRequest,
  });

  const subscription = await validSubscription();
  await assert.rejects(
    () => sender.sendApprovalPush(subscription, randomUUID()),
    "a 5xx from the push service must surface so the fallback can run",
  );
  assert.ok(calls.length >= 1, "the send was attempted");
});

test("a network error reaching the push service is reported to the caller", async () => {
  const build = fakeBuildRequest();
  const { calls, fetch } = throwingFetch();
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: await vapidPrivateKey() },
    fetch,
    buildRequest: build.buildRequest,
  });

  const subscription = await validSubscription();
  await assert.rejects(() => sender.sendApprovalPush(subscription, randomUUID()));
  assert.ok(calls.length >= 1, "the send was attempted before the error surfaced");
});

// ---------------------------------------------------------------------------
// Obligation (validate-and-parameterize-input, the validate half): malformed and
// oversized input is rejected and NOTHING is sent. Uses the real builder so the
// validation is genuine.
// ---------------------------------------------------------------------------

test("a non-HTTPS subscription endpoint is rejected and nothing is sent", async () => {
  const { calls, fetch } = recordingFetch();
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: await vapidPrivateKey() },
    fetch,
  });

  const subscription = await validSubscription();
  const insecure = { ...subscription, endpoint: subscription.endpoint.replace("https:", "http:") };

  await assert.rejects(() => sender.sendApprovalPush(insecure, randomUUID()));
  assert.equal(calls.length, 0, "no push is POSTed for a non-HTTPS endpoint");
});

test("an oversized payload is rejected and nothing is sent", async () => {
  const { calls, fetch } = recordingFetch();
  const sender = createWebPushSender({
    vapid: { subject: SUBJECT, publicKey: "pub", privateKey: await vapidPrivateKey() },
    fetch,
  });

  // An approval id far larger than the 4 KB Web Push payload cap.
  const oversized = "x".repeat(5000);
  const subscription = await validSubscription();

  await assert.rejects(() => sender.sendApprovalPush(subscription, oversized));
  assert.equal(calls.length, 0, "no push is POSTed when the payload exceeds the 4 KB cap");
});
