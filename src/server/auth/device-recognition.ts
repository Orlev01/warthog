// Recognising a browser a person has signed in on before (review fix B7). The brief asks
// for "email alerts for ... a sign-in from a new device"; alerting on every sign-in
// would train people to ignore the email, so a browser that signs in successfully is
// given a long-lived device cookie, and a later sign-in presenting it is recognised.
//
// The cookie needs no table: its value is a random id plus a keyed HMAC binding that id
// to the person who signed in (`warthog/device/v1:<userId>:<id>`), so it verifies only
// for that person, cannot be forged without the server's HMAC key, and does not carry
// the user id itself. It is host-locked (`__Host-`), HttpOnly, Secure and SameSite=Lax,
// like the session cookie, and lives about 400 days (the browser maximum). It
// recognises a browser; it authenticates nothing.
//
// `describeDevice` turns the User-Agent into a short plain label for the alert ("Safari
// on iPhone"). It only ever answers from a fixed vocabulary, so nothing from the header
// itself reaches an email.

import { hmac, verifyHmac } from "../crypto/hmac";
import type { Random } from "../seams/random";

export const DEVICE_COOKIE_NAME = "__Host-wh_device";

const DEVICE_ID_BYTES = 16;
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const BINDING_CONTEXT = "warthog/device/v1";

function binding(userId: string, deviceId: string): string {
  return `${BINDING_CONTEXT}:${userId}:${deviceId}`;
}

// The Set-Cookie value marking this browser as one `userId` has signed in on.
export function deviceCookieFor(
  userId: string,
  deps: { hmacKey: Uint8Array; random: Random },
): string {
  const deviceId = Buffer.from(deps.random.randomBytes(DEVICE_ID_BYTES)).toString("hex");
  const value = `${deviceId}.${hmac(deps.hmacKey, binding(userId, deviceId))}`;
  return `${DEVICE_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`;
}

// Pull one cookie's value out of the request's Cookie header, or null when absent.
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Whether the request comes from a browser `userId` has signed in on before: it carries
// a device cookie whose HMAC verifies (in constant time) for this person.
export function isRecognisedDevice(request: Request, userId: string, hmacKey: Uint8Array): boolean {
  const value = readCookie(request, DEVICE_COOKIE_NAME);
  if (value == null) return false;
  const match = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(value);
  if (!match) return false;
  return verifyHmac(hmacKey, binding(userId, match[1]!), match[2]!);
}

// A short, plain label for the browser in the alert, from a fixed vocabulary only.
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "an unrecognised browser";
  const ua = userAgent;

  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows NT/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;

  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;

  if (system && browser) return `${browser} on ${system}`;
  if (system) return `a browser on ${system}`;
  if (browser) return browser;
  return "an unrecognised browser";
}
