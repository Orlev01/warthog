// The passkey ceremony that evaluates the vault's PRF salt, as the browser actually needs it.
//
// The server's unlock material carries WebAuthn options as JSON, so the PRF eval salt is a
// base64url string. @simplewebauthn/browser's startAuthentication converts the challenge and
// credential ids but passes `extensions` to navigator.credentials.get verbatim, and WebAuthn
// requires a BufferSource for `prf.eval.first`/`second` — so in a real browser every vault
// unlock was rejected (the unit tests ran on fakes that skipped this step). The browser also
// returns the PRF output as an ArrayBuffer, while the vault code reads base64url. This module
// converts both ways, so every caller keeps the JSON-shaped assertion it already expects.
//
// Browser-only at run time (WebAuthn); the conversion is pure, with `startAuthentication`
// injectable for tests.

import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

import type { PasskeyAssertion } from "./device-vault";

type Start = (opts: { optionsJSON: unknown }) => Promise<unknown>;

const defaultStart: Start = (opts) =>
  startAuthentication({ optionsJSON: opts.optionsJSON as PublicKeyCredentialRequestOptionsJSON });

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The options with any base64url PRF eval salts turned into bytes; anything else untouched.
function withPrfSaltsAsBytes(optionsJSON: unknown): unknown {
  const options = optionsJSON as { extensions?: { prf?: { eval?: Record<string, unknown> } } } | null;
  const evalInputs = options?.extensions?.prf?.eval;
  if (!evalInputs) return optionsJSON;
  const converted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(evalInputs)) {
    converted[name] = typeof value === "string" ? base64UrlToBytes(value) : value;
  }
  return {
    ...options,
    extensions: { ...options.extensions, prf: { ...options.extensions!.prf, eval: converted } },
  };
}

// The assertion with a binary PRF output re-encoded as base64url (already-string output, as
// test fakes return, is left alone).
function withPrfOutputAsBase64Url(assertion: PasskeyAssertion): PasskeyAssertion {
  const first: unknown = assertion.clientExtensionResults?.prf?.results?.first;
  if (first === undefined || typeof first === "string") return assertion;
  const bytes =
    first instanceof ArrayBuffer
      ? new Uint8Array(first)
      : ArrayBuffer.isView(first)
        ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
        : null;
  if (bytes === null) return assertion;
  const results = assertion.clientExtensionResults!;
  return {
    ...assertion,
    clientExtensionResults: { ...results, prf: { ...results.prf, results: { first: bytesToBase64Url(bytes) } } },
  };
}

// Run the passkey prompt with these (JSON) options, evaluating any PRF salt they carry.
export async function startVaultAuthentication(
  optionsJSON: unknown,
  start: Start = defaultStart,
): Promise<PasskeyAssertion> {
  const assertion = (await start({ optionsJSON: withPrfSaltsAsBytes(optionsJSON) })) as PasskeyAssertion;
  return withPrfOutputAsBase64Url(assertion);
}
