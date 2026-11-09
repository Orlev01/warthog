// E12-S02 — the real Web Push sender (design §10 Notifications). This is the
// production implementation that sits behind the done PushSender channel: it signs
// a VAPID push with `@pushforge/builder` and POSTs it to one device's push service.
//
// The payload carries ONLY the approval id — never any personal content — so a push
// that is cached or logged by the browser/push service reveals nothing about the
// request (the app fetches the detail from an authenticated session when the person
// opens the notification). The signing key and contact subject are READ FROM CONFIG
// (`src/server/config.ts`, INV-103 secrets-from-env); nothing is baked into source.
//
// Every dependency that touches the outside world is injected behind a seam so the
// tests run with no network: `fetch` (prod injects the SSRF-guarded fetch, tests a
// recorder) and the optional `buildRequest` over the builder (defaults to the real
// signer; tests fake it to inspect the plaintext payload — the HTTP body is
// encrypted and cannot be read back).

import { buildPushHTTPRequest } from "@pushforge/builder";
import { z } from "zod";

import type { VapidConfig } from "../config";
import { HttpError, parseParams } from "../http/validate";

// The Web Push payload cap (RFC 8291): a push body must be at most 4 KB. We cap the
// PLAINTEXT payload we hand the signer, so an oversized value is refused before it is
// ever signed or sent.
const MAX_PAYLOAD_BYTES = 4096;

// One device's subscription, exactly the shape `push-subscriptions` stores: the
// push-service endpoint plus the two browser keys the builder encrypts to.
export interface PushDeviceSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

// The HTTP seam. A send is a single POST; the result is inspected only for success.
// The SSRF-guarded fetch (prod) and a test recorder both satisfy this.
export interface PushResponse {
  readonly ok: boolean;
  readonly status: number;
}
export type PushFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string> | Headers;
    body: ArrayBuffer;
  },
) => Promise<PushResponse>;

// What `createWebPushSender` needs: the VAPID config group (keys from config, never
// source), the HTTP seam, and an optional override of the builder for tests.
export interface WebPushSenderDeps {
  readonly vapid: VapidConfig;
  readonly fetch: PushFetch;
  readonly buildRequest?: typeof buildPushHTTPRequest;
}

export interface WebPushSender {
  sendApprovalPush(subscription: PushDeviceSubscription, approvalId: string): Promise<void>;
  sendNotificationPush(subscription: PushDeviceSubscription): Promise<void>;
}

export class PushDeliveryError extends Error {
  constructor(readonly status: number) { super("Push delivery failed"); }
}

// Validate the untrusted subscription at the boundary: a non-empty, bounded endpoint
// that is a well-formed HTTPS URL, and the two bounded browser keys. A non-HTTPS or
// mis-shaped subscription is rejected here with a 4xx and never reaches the signer.
const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, "push endpoints must use HTTPS"),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

const approvalIdSchema = z.string().min(1);

// Build the real Web Push sender. Keys come from the injected config; failures are
// reported to the caller (rejected), never swallowed, so a fallback channel can run.
export function createWebPushSender(deps: WebPushSenderDeps): WebPushSender {
  const build = deps.buildRequest ?? buildPushHTTPRequest;
  async function send(subscription: PushDeviceSubscription, approvalId?: string): Promise<void> {
      // Keys read from config — never a hard-coded fallback. A missing key is
      // reported, not quietly signed, so the absence surfaces to the caller.
      const { subject, privateKey } = deps.vapid;
      if (!privateKey) {
        throw new Error("Web Push send refused: VAPID private key is not configured");
      }
      if (!subject) {
        throw new Error("Web Push send refused: VAPID subject is not configured");
      }

      // Validate untrusted input before anything is signed or sent (a 4xx on bad
      // input; nothing is POSTed).
      const validSubscription = parseParams(subscriptionSchema, subscription);
      const validApprovalId = approvalId === undefined ? undefined : parseParams(approvalIdSchema, approvalId);

      // The payload carries ONLY the approval id — no personal content. Enforce the
      // 4 KB cap on the plaintext before signing, so an oversized value is refused.
      const payload: Record<string, string> = validApprovalId === undefined ? {} : { approvalId: validApprovalId };
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
        throw new HttpError(413, "push payload exceeds the 4 KB limit");
      }

      const request = await build({
        privateJWK: privateKey,
        message: { payload, adminContact: subject },
        subscription: validSubscription,
      });

      const response = await deps.fetch(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });

      // A non-2xx from the push service is reported, not swallowed, so the caller can
      // fall back to another channel.
      if (!response.ok) {
        throw new PushDeliveryError(response.status);
      }
  }
  return {
    sendApprovalPush: (subscription, approvalId) => send(subscription, approvalId),
    sendNotificationPush: (subscription) => send(subscription),
  };
}
