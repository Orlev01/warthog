// E05-S05 — Install and notification-permission prompts (src/components/pwa/install-prompt.tsx).
//
// RED-first: src/components/pwa/install-prompt.tsx does NOT exist yet, so importing
// `./install-prompt` throws and EVERY test in this file fails until the builder adds it.
// That absence is the entire point of test-first — do NOT implement anything to make
// these pass.
//
// Why this task exists (E05-S05):
//   What: Build the install sheet and notification-permission prompt component with
//         plain reasons.
//   Why:  People are asked to install and allow notifications at the right moment with a
//         plain reason.
//   Acceptance criteria:
//     1. Shows an iOS install sheet AND an Android install affordance AND requests
//        notification permission ONLY on a user action, not on load.
//     2. The permission prompt states a plain reason.
//
// ── How these tests stay honest (and runnable without a DOM) ──────────────────────────
// There is no jsdom / testing-library on this job and React component / E2E testing is a
// per-job ADR, so the interactive BEHAVIOUR (requesting permission, triggering the native
// install prompt) is NOT driven through a rendered DOM — `renderToStaticMarkup` renders a
// client component's markup but never runs its effects or dispatches its click handlers.
//
// So, exactly as the sibling auth flows do (createSigninFlow / createFactorControls), the
// user-action logic lives in a framework-free, injectable CONTROLLER — `createInstallPrompt`
// — that `install-prompt.tsx` exports ALONGSIDE its default `"use client"` component. The
// controller is where the real guarantee lives: creating it (the component "loading") must
// NOT request notification permission; only its `enableNotifications()` action — wired to a
// button's onClick in the browser — may. We drive the controller directly with FAKE seams
// and assert what it DOES (which browser API it calls, how many times, what it records),
// never the source text of the module. A later behaviour-preserving refactor stays green.
//
// `install-prompt.tsx` is a plain component module (NOT a Next route/page entry), so it may
// freely export a named factory beside its default component — no sibling file is needed.
//
// The platform (iOS vs Android vs other) and the browser APIs are SEAMS: in the browser the
// component reads `navigator.userAgent` and the global `Notification` / the captured
// `beforeinstallprompt` event; in a test we INJECT them, so detection and rendering are
// deterministic with no globals.
//
// The contract the builder implements (exactly this), exported from `./install-prompt`:
//
//   type NotificationLike = {
//     permission: NotificationPermission;                       // "default" | "granted" | "denied"
//     requestPermission: () => Promise<NotificationPermission>; // the browser's own API shape
//   };
//   type InstallEventLike = {                                   // a captured `beforeinstallprompt`
//     prompt: () => Promise<void>;
//     userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
//   };
//
//   createInstallPrompt(deps: {
//     userAgent: string;                 // navigator.userAgent — picks "ios" | "android" | "other"
//     notification?: NotificationLike;   // the Notification API seam (absent ⇒ unsupported)
//     installEvent?: InstallEventLike | null;  // the captured Android install event (if any)
//     // (any FURTHER deps the component wires must be OPTIONAL)
//   }): InstallPromptController
//
//   InstallPromptController = {
//     getState(): { platform: "ios" | "android" | "other"; notificationPermission: NotificationPermission };
//     enableNotifications(): Promise<void>;  // the USER ACTION: calls notification.requestPermission() ONCE
//     promptInstall(): Promise<void>;        // the USER ACTION: calls installEvent.prompt() ONCE (Android)
//   }
//
//   default InstallPrompt(props?: {
//     userAgent?: string;                       // defaults to navigator.userAgent in the browser
//     notification?: NotificationLike;          // defaults to the global Notification in the browser
//     installEvent?: InstallEventLike | null;   // defaults to the captured beforeinstallprompt event
//   }): JSX.Element     // a "use client" component
//     • platform "ios"   → an install SHEET: plain instructions to tap Share then
//                          "Add to Home Screen" (iOS Safari cannot install programmatically).
//     • platform "android" (with a captured install event) → an actionable install button.
//     • Whenever a notification seam is present AND its permission is "default" (undecided),
//       on ANY platform → a notification-permission prompt: a PLAIN REASON (visible text)
//       together with an actionable "enable notifications" control. Rendering it must NOT
//       call requestPermission (that only happens on the user's click).
//     • Built on the design tokens (globals.css); never a raw hex colour.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import InstallPrompt, { createInstallPrompt } from "./install-prompt";

// ── Platform seams ────────────────────────────────────────────────────────────────────
// Real user-agent strings. The Android UA contains neither "iPhone/iPad/iPod"; the iOS UA
// contains no "Android"; the desktop UA contains neither — so detection is unambiguous.
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Spies ──────────────────────────────────────────────────────────────────────────────
// A Notification seam whose requestPermission records every call and resolves to a chosen
// outcome. Counting the calls is how we prove "not on load" (0 after create/render) vs
// "on a user action" (1 after enableNotifications()).
function spyNotification(options?: {
  permission?: NotificationPermission;
  resolveTo?: NotificationPermission;
}) {
  const calls: number[] = [];
  const resolveTo: NotificationPermission = options?.resolveTo ?? "granted";
  return {
    calls,
    seam: {
      permission: options?.permission ?? ("default" as NotificationPermission),
      requestPermission: async (): Promise<NotificationPermission> => {
        calls.push(Date.now());
        return resolveTo;
      },
    },
  };
}

// A captured beforeinstallprompt event whose prompt() records every call.
function spyInstallEvent() {
  const calls: number[] = [];
  return {
    calls,
    seam: {
      prompt: async (): Promise<void> => {
        calls.push(Date.now());
      },
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    },
  };
}

// ── Markup readers (behaviour, never source text) ───────────────────────────────────────
// The visible text of rendered markup, tags stripped — exactly the words a sighted person
// reads (an <svg> icon contributes none).
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The visible text OUTSIDE any <button> — the explanatory/instruction region, so a check on
// "a reason sentence" is not skewed by a control's short label.
function textOutsideButtons(markup: string): string {
  return visibleText(markup.replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, " "));
}

// The inner (stripped) text of every <button> rendered — one entry per button element.
function buttonTexts(markup: string): string[] {
  const out: string[] = [];
  const re = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    out.push(
      m[1]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
}

// The OPENING tag of every <button> (to read attributes, e.g. the native `disabled`).
function buttonOpenTags(markup: string): string[] {
  return markup.match(/<button\b[^>]*>/gi) ?? [];
}

// Index of the first button whose visible label matches `re`.
function findButton(markup: string, re: RegExp): number {
  return buttonTexts(markup).findIndex((label) => re.test(label));
}

// A notification "enable" control: its label names notifications (the only control that lets
// someone allow them). Deliberately permissive on the verb ("Allow"/"Turn on"/"Enable"…).
const NOTIFY_BUTTON = /\bnotif(y|ication|ications)?\b/i;

// An install trigger label (the Android affordance). Permissive on wording.
const INSTALL_BUTTON = /\b(install|add to home|add app)\b/i;

// Security / protocol / platform jargon that must never surface on this plain-language
// prompt (brief design_ux.copy). Scoped to THIS component's own rendered text — the same
// word appearing elsewhere in the app is irrelevant.
const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "MCP", re: /\bmcp\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "encryption key", re: /\bencryption key\b/i },
  { label: "cipher / ciphertext", re: /\bcipher(text)?\b/i },
  { label: "PWA", re: /\bpwa\b/i },
  { label: "service worker", re: /\bservice worker\b/i },
  { label: "manifest", re: /\bmanifest\b/i },
  { label: "beforeinstallprompt", re: /\bbeforeinstallprompt\b/i },
];

// ════════════════════════════════════════════════════════════════════════════════════════
// Controller — platform detection (AC1: iOS vs Android drive which affordance is shown)
// ════════════════════════════════════════════════════════════════════════════════════════

test("detects iOS from an iPhone user agent", () => {
  const controller = createInstallPrompt({ userAgent: IOS_UA });
  assert.equal(controller.getState().platform, "ios");
});

test("detects Android from an Android user agent", () => {
  const controller = createInstallPrompt({ userAgent: ANDROID_UA });
  assert.equal(controller.getState().platform, "android");
});

test("classifies a desktop user agent as neither iOS nor Android (other)", () => {
  const controller = createInstallPrompt({ userAgent: DESKTOP_UA });
  assert.equal(controller.getState().platform, "other");
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Controller — notification permission is requested ONLY on a user action, not on load (AC1)
// ════════════════════════════════════════════════════════════════════════════════════════

test("creating the controller does NOT request notification permission (not on load)", () => {
  const notif = spyNotification({ permission: "default" });
  createInstallPrompt({ userAgent: ANDROID_UA, notification: notif.seam });

  assert.equal(
    notif.calls.length,
    0,
    "constructing the install prompt (i.e. the component loading) must never call Notification.requestPermission",
  );
});

test("the initial state reflects the current permission without asking for it", () => {
  const notif = spyNotification({ permission: "default" });
  const controller = createInstallPrompt({ userAgent: ANDROID_UA, notification: notif.seam });

  assert.equal(controller.getState().notificationPermission, "default");
  assert.equal(notif.calls.length, 0, "reading state must not trigger a permission request");
});

test("enableNotifications() requests permission exactly once — the user action", async () => {
  const notif = spyNotification({ permission: "default", resolveTo: "granted" });
  const controller = createInstallPrompt({ userAgent: ANDROID_UA, notification: notif.seam });

  await controller.enableNotifications();

  assert.equal(
    notif.calls.length,
    1,
    "enableNotifications() is the user action — it must call Notification.requestPermission exactly once",
  );
});

test("after the user allows, the recorded permission reflects the outcome", async () => {
  const notif = spyNotification({ permission: "default", resolveTo: "granted" });
  const controller = createInstallPrompt({ userAgent: ANDROID_UA, notification: notif.seam });

  await controller.enableNotifications();

  assert.equal(
    controller.getState().notificationPermission,
    "granted",
    "the controller must record the permission the browser returned so the prompt can stop showing",
  );
});

test("enableNotifications() does not throw when notifications are unsupported", async () => {
  // No notification seam ⇒ the browser has no Notification API. The control must fail
  // gracefully (never fail silently with a thrown error), per the error-handling convention.
  const controller = createInstallPrompt({ userAgent: ANDROID_UA });
  await assert.doesNotReject(() => controller.enableNotifications());
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Controller — the install affordance is wired, not a dead control (AC1)
// ════════════════════════════════════════════════════════════════════════════════════════

test("promptInstall() triggers the captured install event exactly once — the user action", async () => {
  const install = spyInstallEvent();
  const controller = createInstallPrompt({
    userAgent: ANDROID_UA,
    installEvent: install.seam,
  });

  assert.equal(install.calls.length, 0, "the install event must not fire just from loading");

  await controller.promptInstall();

  assert.equal(
    install.calls.length,
    1,
    "promptInstall() is the user action — it must call the captured beforeinstallprompt's prompt() once",
  );
});

test("promptInstall() does not throw when no install event was captured", async () => {
  const controller = createInstallPrompt({ userAgent: ANDROID_UA, installEvent: null });
  await assert.doesNotReject(() => controller.promptInstall());
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Component render — iOS shows an install SHEET with plain instructions (AC1)
// ════════════════════════════════════════════════════════════════════════════════════════

test("on iOS, renders an install sheet telling the person to Share then Add to Home Screen", () => {
  const markup = renderToStaticMarkup(<InstallPrompt userAgent={IOS_UA} />);
  const text = visibleText(markup);

  // iOS Safari cannot install programmatically — the only affordance is the plain gesture.
  assert.match(
    text,
    /share/i,
    `the iOS sheet must name the Share action, got visible text: "${text}"`,
  );
  assert.match(
    text,
    /add to home screen/i,
    `the iOS sheet must tell the person to Add to Home Screen, got visible text: "${text}"`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Component render — Android shows an actionable install affordance (AC1)
// ════════════════════════════════════════════════════════════════════════════════════════

test("on Android with a captured install event, renders an actionable install button", () => {
  const install = spyInstallEvent();
  const markup = renderToStaticMarkup(
    <InstallPrompt userAgent={ANDROID_UA} installEvent={install.seam} />,
  );

  const idx = findButton(markup, INSTALL_BUTTON);
  assert.ok(
    idx !== -1,
    `Android must present an install affordance (a button labelled to install), got buttons: ${JSON.stringify(
      buttonTexts(markup),
    )}`,
  );

  // React renders a true boolean `disabled` prop as `disabled=""`; matching the ATTRIBUTE
  // (never a Tailwind `disabled:` class) proves the affordance is actionable, not dead.
  const tag = buttonOpenTags(markup)[idx] ?? "";
  assert.ok(
    !tag.includes('disabled=""'),
    `the Android install button must be actionable (no native disabled attribute), got: ${tag}`,
  );
});

test("rendering the Android affordance does not auto-fire the install prompt (not on load)", () => {
  const install = spyInstallEvent();
  renderToStaticMarkup(<InstallPrompt userAgent={ANDROID_UA} installEvent={install.seam} />);

  assert.equal(
    install.calls.length,
    0,
    "the native install prompt must only fire on the person's click, never during render",
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Component render — the notification prompt states a PLAIN REASON and never asks on load
// (AC1 "only on a user action, not on load" + AC2 "states a plain reason")
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Rendered on a desktop ("other") UA so there is no install affordance to clutter the
// output — the only content is the notification-permission prompt, isolating its reason.
// The notification prompt is platform-independent: it appears whenever notifications are
// supported and the decision is still "default".

test("the notification prompt renders a plain reason alongside an actionable enable control", () => {
  const notif = spyNotification({ permission: "default" });
  const markup = renderToStaticMarkup(
    <InstallPrompt userAgent={DESKTOP_UA} notification={notif.seam} />,
  );

  // The enable control is present and actionable (no dead control).
  const idx = findButton(markup, NOTIFY_BUTTON);
  assert.ok(
    idx !== -1,
    `the notification prompt must offer an enable-notifications control, got buttons: ${JSON.stringify(
      buttonTexts(markup),
    )}`,
  );
  const tag = buttonOpenTags(markup)[idx] ?? "";
  assert.ok(
    !tag.includes('disabled=""'),
    `the enable-notifications control must be actionable (no native disabled attribute), got: ${tag}`,
  );

  // A plain REASON: real explanatory text accompanies the control — it is not a bare button.
  const reason = textOutsideButtons(markup);
  assert.ok(
    reason.length >= 20,
    `the notification prompt must state a plain reason (visible explanatory text), got: "${reason}"`,
  );
});

test("the notification prompt's reason uses plain words — no security or protocol jargon", () => {
  const notif = spyNotification({ permission: "default" });
  const text = visibleText(
    renderToStaticMarkup(<InstallPrompt userAgent={DESKTOP_UA} notification={notif.seam} />),
  );

  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(text),
      `the prompt must say WHY in plain words — found jargon "${label}" in: "${text}"`,
    );
  }
});

test("rendering the notification prompt does NOT request permission (not on load)", () => {
  const notif = spyNotification({ permission: "default" });
  renderToStaticMarkup(<InstallPrompt userAgent={DESKTOP_UA} notification={notif.seam} />);

  assert.equal(
    notif.calls.length,
    0,
    "merely showing the prompt must never call Notification.requestPermission — only the click may",
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Design system — colour comes from tokens, never a raw hex literal
// ════════════════════════════════════════════════════════════════════════════════════════

test("renders on design tokens, never a raw hex colour (iOS and Android)", () => {
  const install = spyInstallEvent();
  const ios = renderToStaticMarkup(<InstallPrompt userAgent={IOS_UA} />);
  const android = renderToStaticMarkup(
    <InstallPrompt userAgent={ANDROID_UA} installEvent={install.seam} />,
  );

  for (const [name, markup] of [
    ["iOS", ios],
    ["Android", android],
  ] as const) {
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the ${name} install-prompt markup, got: ${markup}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Review fix W4.1 — mounted on Home without a hydration mismatch, hideable where Settings →
// Notifications already offers notifications, and a notification tap that really sets up
// this device for push.
// ════════════════════════════════════════════════════════════════════════════════════════

// Install browser-like globals for the duration of `fn`, then restore them.
function withBrowserGlobals(userAgent: string, notification: unknown, fn: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const hadNotification = Object.hasOwn(globalThis, "Notification");
  const previousNotification = g.Notification;
  Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true, writable: true });
  g.Notification = notification;
  try {
    fn();
  } finally {
    if (navDescriptor) Object.defineProperty(globalThis, "navigator", navDescriptor);
    else delete g.navigator;
    if (hadNotification) g.Notification = previousNotification;
    else delete g.Notification;
  }
}

test("W4.1: the first render never reads the browser, so server and client markup match", () => {
  const notif = spyNotification({ permission: "default" });
  withBrowserGlobals(IOS_UA, notif.seam, () => {
    const text = visibleText(renderToStaticMarkup(<InstallPrompt />));
    assert.doesNotMatch(text, /add to home screen/i, `no platform-specific section before mount; text="${text}"`);
    assert.doesNotMatch(text, /stay in the loop|notifications/i, `no notification section before mount; text="${text}"`);
  });
});

test("W4.1: showNotifications={false} hides the notification part (Settings → Notifications offers it)", () => {
  const notif = spyNotification({ permission: "default" });
  const markup = renderToStaticMarkup(
    <InstallPrompt userAgent={IOS_UA} notification={notif.seam} showNotifications={false} />,
  );
  assert.equal(findButton(markup, NOTIFY_BUTTON), -1, "no notification control");
  assert.match(visibleText(markup), /add to home screen/i, "the install part still shows");
});

test("W4.1: an app already installed to the home screen is not asked to install again", () => {
  const install = spyInstallEvent();
  for (const element of [
    <InstallPrompt key="ios" userAgent={IOS_UA} standalone={true} />,
    <InstallPrompt key="android" userAgent={ANDROID_UA} installEvent={install.seam} standalone={true} />,
  ]) {
    const markup = renderToStaticMarkup(element);
    assert.doesNotMatch(visibleText(markup), /add to home screen/i);
    assert.equal(findButton(markup, INSTALL_BUTTON), -1);
  }
});

test("W4.1: with a device registrar, turning notifications on sets this device up (and asks only on the tap)", async () => {
  const notif = spyNotification({ permission: "default" });
  const registrations: number[] = [];
  const controller = createInstallPrompt({
    userAgent: ANDROID_UA,
    notification: notif.seam,
    registerDevice: async () => {
      registrations.push(1);
      return { ok: true };
    },
  });
  assert.equal(registrations.length, 0, "nothing is set up on load");
  await controller.enableNotifications();
  assert.equal(registrations.length, 1, "the tap sets this device up once");
  assert.equal(notif.calls.length, 0, "the registrar asks for permission itself (permission first, in the tap)");
  assert.equal(controller.getState().deviceSetup, "done");
});

test("W4.1: a refused or failed device set-up is reported in plain words, never silently", async () => {
  for (const [reason, expected] of [
    ["push_denied", "denied"],
    ["push_unavailable", "unavailable"],
    ["register_failed", "failed"],
  ] as const) {
    const controller = createInstallPrompt({
      userAgent: DESKTOP_UA,
      notification: spyNotification().seam,
      registerDevice: async () => ({ ok: false, reason }),
    });
    await controller.enableNotifications();
    assert.equal(controller.getState().deviceSetup, expected, reason);
  }
  const throwing = createInstallPrompt({
    userAgent: DESKTOP_UA,
    notification: spyNotification().seam,
    registerDevice: async () => {
      throw new Error("offline");
    },
  });
  await assert.doesNotReject(() => throwing.enableNotifications());
  assert.equal(throwing.getState().deviceSetup, "failed");
});
