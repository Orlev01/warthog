// TOTP authenticator fallback (design §5): the second factor for people who do
// not use a passkey. Enrolment draws a fresh shared secret, hands the
// authenticator app an otpauth key-URI (and a QR to scan it from), and verify
// checks the six-digit code the app shows against RFC 6238 TOTP — SHA-1, a
// 30-second step, six digits, with a ±1-step tolerance for clock skew.
//
// The module is PURE (conventions: src/server/** draws entropy and time through
// seams, never the crypto library or a wall clock directly): enrol takes the
// `random` seam, verify takes the `clock` seam, so the algorithm is the ordinary
// interoperable TOTP a standard authenticator app computes — no network, no Azure.

import { createHmac, timingSafeEqual } from "node:crypto";
import { toDataURL } from "qrcode";

import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";

const STEP_SECONDS = 30; // the TOTP time step
const DIGITS = 6;
const MODULUS = 10 ** DIGITS;
const SECRET_BYTES = 20; // 160 bits — the standard SHA-1 TOTP secret, ≥ 128 bits
const SKEW_STEPS = 1; // accept the step before and after now (±1) for clock skew

// RFC 4648 base32 alphabet (A–Z, 2–7): the form an authenticator app and the
// otpauth URI both expect the shared secret in.
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Encode raw key bytes to RFC 4648 base32. SECRET_BYTES (20) is a multiple of 5,
// so the output is a whole number of base32 characters and needs no `=` padding.
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

// Decode a base32 secret back to its raw key bytes. Padding and any stray
// character are ignored, so a secret the person types or pastes still decodes.
function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// HOTP(key, counter) over SHA-1 with dynamic truncation to six digits — the
// RFC 4226 construction TOTP counts time steps through (RFC 6238).
function hotpSha1(key: Uint8Array, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(key)).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % MODULUS).toString().padStart(DIGITS, "0");
}

// Constant-time compare of two equal-length six-digit codes, so a wrong guess
// leaks nothing about the correct code through timing.
function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

// Enrol a new authenticator: draw a fresh shared secret, embed it in the otpauth
// key-URI the app provisions from, and render that URI to a QR image the
// enrolment screen can show. The returned `secret` is what verifyTotp consumes.
export async function enrollTotp(
  params: { account: string; issuer: string },
  deps: { random: Random },
): Promise<{ secret: string; uri: string; qr: string }> {
  const secret = base32Encode(deps.random.randomBytes(SECRET_BYTES));

  // otpauth://totp/<issuer>:<account>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  const uri = `otpauth://totp/${label}?${query.toString()}`;

  const qr = await toDataURL(uri);
  return { secret, uri, qr };
}

// Verify a presented code against the secret for the current 30-second step and
// the steps ±1 away (the skew window). Malformed input — anything that is not
// exactly six digits — is rejected, never thrown.
export function verifyTotp(secret: string, code: string, deps: { clock: Clock }): boolean {
  return matchTotpStep(secret, code, deps) !== null;
}

// The 30-second step a presented code belongs to (the current step or one ±1 away), or
// null when it matches none — what a single-use check records, so a code (or one from an
// earlier step) cannot be accepted twice (review fix W3.5, `./totp-attempts`).
export function matchTotpStep(secret: string, code: string, deps: { clock: Clock }): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;

  const key = base32Decode(secret);
  if (key.length === 0) return null;

  const step = Math.floor(deps.clock.now().getTime() / 1000 / STEP_SECONDS);
  let matched: number | null = null;
  for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset += 1) {
    // Every candidate is compared (no early exit), so timing does not reveal which matched.
    if (codesEqual(hotpSha1(key, step + offset), code)) matched = step + offset;
  }
  return matched;
}
