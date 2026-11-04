// E04-S05 — TOTP authenticator fallback (`src/server/auth/totp.ts`).
//
// RED-first: the totp module does not exist yet, so importing `./totp` throws and
// every test here fails until the builder adds it. That absence IS the point of
// test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what enrol produces, what verify accepts/rejects, and
// — through published RFC 6238 test vectors — that the algorithm really is the
// interoperable SHA-1 / 30-second / 6-digit TOTP a standard authenticator app
// computes), never the source text of the module. A later rename that preserves
// behaviour must not redden them. The module is PURE: it draws entropy through the
// `random` seam and reads the instant through the `clock` seam (design §5: "RFC 6238
// TOTP implemented with node:crypto (30 s, 6 digits, ±1 step)"), so there is no
// network, no Azure and no wall-clock dependence here.
//
// The contract this task defines (the builder implements exactly this):
//
//   enrollTotp(
//     params: { account: string; issuer: string },
//     deps: { random: Random },
//   ): Promise<{ secret: string; uri: string; qr: string }>
//     • `secret` — a freshly drawn shared secret as an RFC 4648 base32 string
//       (alphabet A–Z 2–7, optional `=` padding), ≥ 128 bits of entropy. This is the
//       SAME secret embedded in `uri` and the one `verifyTotp` later consumes.
//     • `uri`  — the otpauth key-URI the authenticator app provisions from:
//          otpauth://totp/<label>?secret=<base32>&issuer=<issuer>&…digits=6&period=30
//       carrying the base32 secret, `digits=6`, `period=30`, the `issuer` and the
//       account in its label. (If an `algorithm` is named it is SHA1 — the default a
//       standard authenticator assumes when it is omitted.)
//     • `qr`   — the URI rendered to a QR by `qrcode`, as an embeddable image string
//       (a `data:` URL or inline `<svg>`), so an enrolment screen can show it.
//
//   verifyTotp(
//     secret: string,                // the base32 secret from enrol
//     code: string,                  // the 6-digit code the person typed
//     deps: { clock: Clock },
//   ): boolean
//     • true  — `code` matches the TOTP for the current 30-second step OR the step
//       immediately before or after it (the ±1-step tolerance for clock skew).
//     • false — any other code, including one from two or more steps away (outside
//       the window) and any malformed input. verify never throws for a bad code.
//
// Acceptance criteria → tests:
//   AC1 "Generates a secret and otpauth URI (QR via qrcode) and verifies a 30-second,
//        6-digit code within ±1 step." — enrol yields a base32 secret, an otpauth URI
//        carrying it with digits=6/period=30, and a QR image string; the code computed
//        for enrol's own secret verifies; the published RFC 6238 SHA-1 vectors verify
//        (pinning the exact algorithm an authenticator app uses); and the codes for the
//        current step and the steps ±1 away are all accepted.
//   AC2 "Rejects a code outside the window." — the codes two steps away (before and
//        after) are rejected, as is a plainly wrong code; malformed input returns false
//        rather than throwing.
//
// A small REFERENCE TOTP (node:crypto HMAC-SHA1, the RFC 6238 construction) and a
// base32 decoder live in this test so it can compute the codes verify must accept and
// reject independently of the module under test — the same discipline the passkey test
// uses with a real authenticator helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { enrollTotp, verifyTotp } from "./totp";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";

const STEP_SECONDS = 30; // the TOTP time step (design §5)
const DIGITS = 6;
const MODULUS = 10 ** DIGITS;

const ISSUER = "Warthog";
const ACCOUNT = "person@warthog.com.au";

// RFC 6238 Appendix B published test vectors for the SHA-1 seed (ASCII
// "12345678901234567890"). Base32 of that seed, and the reference's own 8-digit
// codes truncated to the low 6 digits (mod 10^6 of the 31-bit DT value equals the low
// 6 digits of the 8-digit value). Hard-coded known answers pin the module to the
// published standard — a self-consistent but non-interoperable variant (SHA-256, a
// different truncation, an 8-step window) would NOT reproduce these.
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: ReadonlyArray<{ epochSeconds: number; code: string }> = [
  { epochSeconds: 59, code: "287082" }, // T=1
  { epochSeconds: 1111111109, code: "081804" }, // T=0x23523EC
];

// ---------------------------------------------------------------------------------
// A reference RFC 6238 TOTP, independent of the module, so the test owns the codes it
// expects verify to accept and reject. Decodes the base32 secret to its raw key bytes,
// then HOTP(key, floor(t/30)) over SHA-1 with dynamic truncation to 6 digits.
// ---------------------------------------------------------------------------------
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue; // ignore separators / stray characters
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

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

// The step index a given instant falls in, and the reference code for a step offset
// from it — the ±N neighbours whose acceptance/rejection the window tests assert.
function stepAt(epochSeconds: number): number {
  return Math.floor(epochSeconds / STEP_SECONDS);
}
function codeForStep(secretB32: string, step: number): string {
  return hotpSha1(base32Decode(secretB32), step);
}

// A frozen clock at a chosen epoch second (verify reads the instant through it).
function clockAt(epochSeconds: number) {
  return { clock: fixedClock(new Date(epochSeconds * 1000)) };
}

// =================================================================================
// AC1 — enrol: a base32 secret, an otpauth URI carrying it, and a QR image.
// =================================================================================

test("enrollTotp generates a base32 shared secret with real entropy", async () => {
  const { secret } = await enrollTotp({ account: ACCOUNT, issuer: ISSUER }, { random: systemRandom });

  // A base32 string (RFC 4648 alphabet, optional padding) — the form an authenticator
  // app and the otpauth URI both expect.
  assert.match(secret, /^[A-Z2-7]+=*$/, "the secret is RFC 4648 base32");

  // ≥ 128 bits: a TOTP shared secret must not be trivially small.
  const rawBytes = base32Decode(secret);
  assert.ok(rawBytes.length >= 16, `the secret must carry ≥ 128 bits of entropy (got ${rawBytes.length} bytes)`);
});

test("two enrolments draw different secrets (the secret is freshly random)", async () => {
  const a = await enrollTotp({ account: ACCOUNT, issuer: ISSUER }, { random: systemRandom });
  const b = await enrollTotp({ account: ACCOUNT, issuer: ISSUER }, { random: systemRandom });
  assert.notEqual(a.secret, b.secret, "each enrolment draws a fresh secret, not a fixed constant");
});

test("enrollTotp builds an otpauth URI carrying the secret, 6 digits, a 30-second period and the issuer/account", async () => {
  const { secret, uri } = await enrollTotp({ account: ACCOUNT, issuer: ISSUER }, { random: systemRandom });

  // The scheme and type mark it as a TOTP provisioning URI.
  assert.ok(uri.startsWith("otpauth://totp/"), `expected an otpauth totp URI, got ${JSON.stringify(uri)}`);

  const parsed = new URL(uri);
  // Carries the SAME secret enrol returned — the app and verify share one secret.
  assert.equal(parsed.searchParams.get("secret"), secret, "the URI embeds enrol's base32 secret");
  // 30-second, 6-digit TOTP (design §5).
  assert.equal(parsed.searchParams.get("digits"), String(DIGITS), "digits=6");
  assert.equal(parsed.searchParams.get("period"), String(STEP_SECONDS), "period=30");
  // Issuer named (recommended by the key-URI format); account shown in the label.
  assert.equal(parsed.searchParams.get("issuer"), ISSUER, "issuer is named in the URI");
  assert.ok(
    decodeURIComponent(parsed.pathname).includes(ACCOUNT),
    "the account appears in the URI label so the authenticator shows which account it is",
  );

  // If an algorithm is named it must be SHA1 — the default a standard authenticator
  // assumes, and what the RFC vectors below pin. (Omitting it is also valid.)
  const algorithm = parsed.searchParams.get("algorithm");
  if (algorithm !== null) {
    assert.equal(algorithm.toUpperCase(), "SHA1", "a named algorithm must be the interoperable SHA1");
  }
});

test("enrollTotp renders the URI to a QR as an embeddable image string (qrcode)", async () => {
  const { qr } = await enrollTotp({ account: ACCOUNT, issuer: ISSUER }, { random: systemRandom });
  assert.equal(typeof qr, "string", "qr is a string");
  assert.ok(qr.length > 0, "qr is non-empty");
  assert.ok(
    qr.startsWith("data:") || qr.includes("<svg"),
    "qr is an embeddable image (a data: URL or inline SVG) an enrolment screen can show",
  );
});

// =================================================================================
// AC1 — verify accepts the current code (and ±1 step), including for enrol's own secret.
// =================================================================================

test("a code computed from enrol's own secret verifies (enrol and verify share one secret)", async () => {
  const { secret } = await enrollTotp({ account: ACCOUNT, issuer: ISSUER }, { random: systemRandom });

  const now = 1_700_000_000; // a fixed instant, year 2023
  const code = codeForStep(secret, stepAt(now));
  assert.equal(
    verifyTotp(secret, code, clockAt(now)),
    true,
    "the current-step code for enrol's secret is accepted",
  );
});

test("the published RFC 6238 SHA-1 vectors verify (the algorithm is the interoperable TOTP)", () => {
  for (const { epochSeconds, code } of RFC_VECTORS) {
    assert.equal(
      verifyTotp(RFC_SECRET_B32, code, clockAt(epochSeconds)),
      true,
      `RFC 6238 vector at t=${epochSeconds}s (${code}) must verify — this pins SHA1/30s/6-digit`,
    );
  }
});

test("verifyTotp accepts the current step and the steps ±1 away (the skew tolerance)", () => {
  const now = 1_000_000_000; // year 2001; a clean mid-step instant
  const step = stepAt(now);

  for (const offset of [-1, 0, +1]) {
    const code = codeForStep(RFC_SECRET_B32, step + offset);
    assert.equal(
      verifyTotp(RFC_SECRET_B32, code, clockAt(now)),
      true,
      `the code ${offset} step(s) from now (${code}) is within the ±1 window and must verify`,
    );
  }
});

// =================================================================================
// AC2 — verify rejects a code outside the ±1 window, and malformed input.
// =================================================================================

test("verifyTotp rejects codes two steps away — outside the ±1 window", () => {
  const now = 1_000_000_000;
  const step = stepAt(now);

  // The accepted window is {step-1, step, step+1}; anything from two steps out is
  // outside it. Guard first that the ±2 codes really differ from every in-window code,
  // so a (astronomically unlikely) collision can never masquerade as a passing reject.
  const windowCodes = new Set([-1, 0, +1].map((d) => codeForStep(RFC_SECRET_B32, step + d)));
  for (const offset of [-2, +2]) {
    const outside = codeForStep(RFC_SECRET_B32, step + offset);
    assert.ok(!windowCodes.has(outside), `the ${offset}-step code must differ from the in-window codes`);
    assert.equal(
      verifyTotp(RFC_SECRET_B32, outside, clockAt(now)),
      false,
      `the code ${offset} steps away (${outside}) is outside the ±1 window and must be rejected`,
    );
  }
});

test("verifyTotp rejects a plainly wrong code", () => {
  const now = 1_000_000_000;
  const step = stepAt(now);

  // Pick a 6-digit code that is NOT any of the three in-window codes, so the rejection
  // is about the window and not an accidental match.
  const windowCodes = new Set([-1, 0, +1].map((d) => codeForStep(RFC_SECRET_B32, step + d)));
  let wrong = "000000";
  for (let n = 0; windowCodes.has(wrong); n += 1) {
    wrong = String(n).padStart(DIGITS, "0");
  }

  assert.equal(verifyTotp(RFC_SECRET_B32, wrong, clockAt(now)), false, "a non-matching code does not verify");
});

test("verifyTotp returns false for malformed input rather than throwing", () => {
  const now = 1_000_000_000;
  for (const bad of ["", "abcdef", "12345", "1234567", "  ", "12 34 56"]) {
    assert.equal(
      verifyTotp(RFC_SECRET_B32, bad, clockAt(now)),
      false,
      `malformed code ${JSON.stringify(bad)} must be rejected, not throw`,
    );
  }
});
