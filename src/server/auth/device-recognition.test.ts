// Review fix B7 — recognising a browser a person has signed in on before
// (`src/server/auth/device-recognition.ts`), so the brief's "email alert for a sign-in
// from a new device" goes out for an unrecognised browser and not on every sign-in.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_COOKIE_NAME,
  deviceCookieFor,
  isRecognisedDevice,
  describeDevice,
} from "./device-recognition";
import { systemRandom } from "../seams/random";

const KEY = new Uint8Array(Buffer.from("warthog-device-recognition-key-0123456789", "utf8"));
const OTHER_KEY = new Uint8Array(Buffer.from("warthog-device-recognition-key-9876543210", "utf8"));
const ALICE = "6f1c9e2a-0000-4000-8000-000000000001";
const BOB = "6f1c9e2a-0000-4000-8000-000000000002";

function requestWith(setCookie: string | null, extra = ""): Request {
  const headers: Record<string, string> = {};
  if (setCookie) headers.cookie = `${extra}${setCookie.split(";")[0]}`;
  return new Request("https://warthog.com.au/api/auth/signin/finish-passkey", { headers });
}

test("the device cookie is a host-locked, HttpOnly, long-lived cookie", () => {
  const cookie = deviceCookieFor(ALICE, { hmacKey: KEY, random: systemRandom });
  assert.ok(cookie.startsWith(`${DEVICE_COOKIE_NAME}=`));
  assert.ok(DEVICE_COOKIE_NAME.startsWith("__Host-"));
  for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
    assert.ok(cookie.includes(attr), `the cookie carries ${attr}`);
  }
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
  assert.ok(maxAge >= 180 * 24 * 60 * 60, "the cookie outlives a session by months");
  assert.ok(!cookie.includes(ALICE), "the cookie does not carry the user id");
});

test("a browser holding the person's device cookie is recognised; anything else is not", () => {
  const cookie = deviceCookieFor(ALICE, { hmacKey: KEY, random: systemRandom });

  assert.equal(isRecognisedDevice(requestWith(cookie), ALICE, KEY), true, "the same person on the same browser");
  assert.equal(isRecognisedDevice(requestWith(cookie, "a=1; "), ALICE, KEY), true, "among other cookies");
  assert.equal(isRecognisedDevice(requestWith(cookie), BOB, KEY), false, "another person on that browser");
  assert.equal(isRecognisedDevice(requestWith(cookie), ALICE, OTHER_KEY), false, "a cookie under another key");
  assert.equal(isRecognisedDevice(requestWith(null), ALICE, KEY), false, "no cookie at all");

  const value = cookie.split(";")[0]!.slice(DEVICE_COOKIE_NAME.length + 1);
  const tampered = `${DEVICE_COOKIE_NAME}=${value.slice(0, -2)}${value.endsWith("00") ? "11" : "00"}`;
  assert.equal(isRecognisedDevice(requestWith(tampered), ALICE, KEY), false, "a tampered cookie");
  assert.equal(isRecognisedDevice(requestWith(`${DEVICE_COOKIE_NAME}=garbage`), ALICE, KEY), false);
});

test("describeDevice names the browser and system in plain words and never echoes the raw header", () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const windowsChrome =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const macFirefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0";
  const edge =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0";
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

  assert.equal(describeDevice(iphone), "Safari on iPhone");
  assert.equal(describeDevice(windowsChrome), "Chrome on Windows");
  assert.equal(describeDevice(macFirefox), "Firefox on Mac");
  assert.equal(describeDevice(edge), "Edge on Windows");
  assert.equal(describeDevice(android), "Chrome on Android");
  assert.equal(describeDevice(null), "an unrecognised browser");
  assert.equal(describeDevice("4111 1111 1111 1111 <script>"), "an unrecognised browser");
});
