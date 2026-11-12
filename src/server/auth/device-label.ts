// The label a new-device sign-in request carries (follow-up S3; see
// docs/adr/security-followups-2026-11.md). The approving device shows it beside "only approve
// if you just tried to sign in on that device yourself", so it must not be text the requester
// chooses: a requester could otherwise call itself "Your iPhone — safe to approve". The label
// is therefore derived on the server from the requesting browser's User-Agent into a FIXED
// vocabulary ("Chrome on Mac", "Safari on iPhone", "Unknown device"). The User-Agent can be
// spoofed too, but only into another plain label from this list.

// Checked in order: the more specific browser tokens first (Edge and Samsung Internet also
// say "Chrome"; Chrome also says "Safari").
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\b(Headless)?Chrome\/|\bCriOS\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMacintosh\b|\bMac OS X\b/, "Mac"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

// A real User-Agent is a few hundred characters; anything far longer is not one.
const MAX_USER_AGENT = 1024;

export const UNKNOWN_DEVICE = "Unknown device";

export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent || userAgent.length > MAX_USER_AGENT) return UNKNOWN_DEVICE;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (!system) return UNKNOWN_DEVICE;
  return `${browser ?? "Unknown browser"} on ${system}`;
}
