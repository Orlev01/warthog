"use client";

import * as React from "react";
import { AlertTriangle, Bell, CheckCircle2, Download, Share } from "lucide-react";

import { Button } from "@/components/ui/button";
import { subscribeThisBrowser, type PushSubscriptionJson } from "@/components/settings/push-subscribe";

// E05-S05 — Install and notification-permission prompts.
//
// People are asked to install Warthog and to allow notifications at the right moment,
// each with a plain-language reason — and permission is requested ONLY when the person
// acts, never just because the prompt loaded.
//
// As the sibling auth flows do (createSigninFlow / createFactorControls), the interactive
// BEHAVIOUR lives in a framework-free, injectable CONTROLLER (`createInstallPrompt`) so it
// is testable without a DOM (React component / E2E testing is a per-job ADR). The
// `InstallPrompt` component is a thin binding over the controller.
//
// The platform (iOS vs Android vs other) and the browser APIs are SEAMS: in the browser
// the component reads `navigator.userAgent`, the global `Notification`, whether the app
// is already installed and the captured `beforeinstallprompt` event; a test injects them,
// so detection and behaviour are deterministic with no globals. The browser defaults are
// read AFTER mount (review fix W4.1): the server render and the first client render both
// see no platform and no notification support, so hydration always matches.
//
// Home mounts it next to the set-up checklist (brief: "install the app and turn on
// notifications"). There "Turn on notifications" sets THIS device up for push — the same
// ceremony as Settings → Notifications' "Register this device" — rather than only asking
// for permission, which on its own would leave nothing to push to. Settings → Notifications
// can hide the notification part (`showNotifications={false}`).

// The browser's Notification API shape (its static side), as a seam.
export type NotificationLike = {
  readonly permission: NotificationPermission; // "default" | "granted" | "denied"
  readonly requestPermission: () => Promise<NotificationPermission>;
};

// A captured `beforeinstallprompt` event (Android/Chromium), as a seam.
export type InstallEventLike = {
  readonly prompt: () => Promise<void>;
  readonly userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallPlatform = "ios" | "android" | "other";

// Setting THIS device up for push (permission first, then the service worker, the
// subscription and the server) as one user action: the outcome codes match
// push-subscribe's, plus a refusal from the server.
export type RegisterDeviceOutcome =
  | { ok: true }
  | { ok: false; reason: "push_unavailable" | "push_denied" | "register_failed" | string };

// Where setting up this device for notifications stands (absent until the person taps).
export type DeviceSetup = "done" | "denied" | "unavailable" | "failed";

export interface InstallPromptDeps {
  readonly userAgent: string; // navigator.userAgent — picks the platform
  readonly notification?: NotificationLike; // absent ⇒ notifications unsupported
  readonly installEvent?: InstallEventLike | null; // the captured Android install event
  // Optional: sets this device up for push on the person's tap (it asks for permission
  // itself, first). Absent ⇒ the tap only asks for notification permission.
  readonly registerDevice?: () => Promise<RegisterDeviceOutcome>;
  // Optional: the component wires this to re-render after each state change. The
  // controller works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface InstallPromptState {
  readonly platform: InstallPlatform;
  readonly notificationPermission: NotificationPermission;
  readonly deviceSetup?: DeviceSetup;
}

// A device set-up outcome → where it stands, in the words the prompt shows.
function deviceSetupOf(outcome: RegisterDeviceOutcome): DeviceSetup {
  if (outcome.ok) return "done";
  if (outcome.reason === "push_denied") return "denied";
  if (outcome.reason === "push_unavailable") return "unavailable";
  return "failed";
}

export interface InstallPromptController {
  getState(): InstallPromptState;
  enableNotifications(): Promise<void>; // the USER ACTION: requests permission ONCE
  promptInstall(): Promise<void>; // the USER ACTION: fires the captured install event ONCE
}

// iOS Safari contains none of Android; Android contains none of iPhone/iPad/iPod — so
// the detection is unambiguous. Anything else (desktop) is "other".
function detectPlatform(userAgent: string): InstallPlatform {
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  if (/android/i.test(userAgent)) return "android";
  return "other";
}

export function createInstallPrompt(deps: InstallPromptDeps): InstallPromptController {
  const platform = detectPlatform(deps.userAgent);
  // Reflect the browser's CURRENT decision without asking for it (reading permission is
  // not a request). Absent ⇒ there is nothing to ask, so treat it as undecided.
  let notificationPermission: NotificationPermission = deps.notification?.permission ?? "default";
  let deviceSetup: DeviceSetup | undefined;

  function getState(): InstallPromptState {
    return { platform, notificationPermission, deviceSetup };
  }

  // The user action. With a device registrar it sets this device up for push (which
  // asks for permission first) and records the outcome, never throwing. Otherwise, with
  // no Notification API there is nothing to ask — fail gracefully (resolve), never throw;
  // a rejected request (e.g. outside a user gesture) leaves the decision undecided so the
  // prompt stays, rather than crashing the control.
  async function enableNotifications(): Promise<void> {
    if (deps.registerDevice) {
      try {
        deviceSetup = deviceSetupOf(await deps.registerDevice());
      } catch {
        deviceSetup = "failed";
      }
      notificationPermission = deps.notification?.permission ?? notificationPermission;
      deps.onChange?.();
      return;
    }
    if (!deps.notification) return;
    try {
      notificationPermission = await deps.notification.requestPermission();
    } catch {
      // leave the recorded permission unchanged
    }
    deps.onChange?.();
  }

  // The user action. With no captured install event there is nothing to fire — fail
  // gracefully, never throw.
  async function promptInstall(): Promise<void> {
    const event = deps.installEvent;
    if (!event) return;
    try {
      await event.prompt();
    } catch {
      // a dismissed / unavailable prompt is not a crash
    }
    deps.onChange?.();
  }

  return { getState, enableNotifications, promptInstall };
}

// --- the client component (a thin binding over the controller) --------------

// The global Notification API, adapted to the seam shape — a STABLE object (memoised by
// the component) so the controller is not rebuilt every render. Absent ⇒ unsupported.
function browserNotification(): NotificationLike | undefined {
  if (typeof globalThis.Notification === "undefined") return undefined;
  const N = globalThis.Notification;
  return {
    get permission() {
      return N.permission;
    },
    requestPermission: () => N.requestPermission(),
  };
}

// Whether the app is already running installed (from the home screen): the standard
// display-mode media query, or iOS Safari's own `navigator.standalone`.
function runningInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const standaloneMedia =
    typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standaloneMedia || iosStandalone;
}

// The register-this-device server action Home hands down (the same contract as Settings →
// Notifications' `registerPushDevice`).
export type RegisterPushDeviceAction = (
  subscription: PushSubscriptionJson,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

// What the browser reports after mount; null until then (server render, first client
// render), so nothing platform-specific renders before hydration.
type BrowserFacts = {
  readonly userAgent: string;
  readonly notification: NotificationLike | undefined;
  readonly standalone: boolean;
};

export interface InstallPromptProps {
  readonly userAgent?: string; // defaults to navigator.userAgent in the browser
  readonly notification?: NotificationLike; // defaults to the global Notification
  readonly installEvent?: InstallEventLike | null; // defaults to the captured event
  readonly standalone?: boolean; // defaults to "is the app already installed?"
  // Hide the notification part where the page already offers it (Settings →
  // Notifications' "Register this device"). Shown by default.
  readonly showNotifications?: boolean;
  // When given, "Turn on notifications" sets this device up for push through this server
  // action (with the public VAPID key), instead of only asking for permission.
  readonly registerPushDevice?: RegisterPushDeviceAction;
  readonly vapidPublicKey?: string;
}

// Plain words for each device set-up outcome (the Settings → Notifications copy).
const DEVICE_SETUP_COPY: Record<DeviceSetup, string> = {
  done: "This device is set up for notifications.",
  denied: "Notifications are turned off for Warthog in this browser. Allow them in your browser settings, then try again.",
  unavailable: "Notifications aren't available on this device or browser.",
  failed: "We couldn't set this device up for notifications. Please try again.",
};

export function InstallPrompt(props: InstallPromptProps): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);

  // The browser is read only after mount (review fix W4.1): reading navigator.userAgent or
  // Notification during render made the server and client markup differ.
  const [browser, setBrowser] = React.useState<BrowserFacts | null>(null);
  React.useEffect(() => {
    setBrowser({
      userAgent: navigator.userAgent,
      notification: browserNotification(),
      standalone: runningInstalled(),
    });
  }, []);

  const userAgent = props.userAgent ?? browser?.userAgent ?? "";
  const notification = props.notification ?? browser?.notification;
  const standalone = props.standalone ?? browser?.standalone ?? false;
  const showNotifications = props.showNotifications ?? true;
  const { registerPushDevice, vapidPublicKey } = props;

  // The captured Android install event: an injected prop wins (including an explicit
  // null); otherwise we capture `beforeinstallprompt` ourselves. Capturing never fires
  // the prompt — it only keeps the event so the person's click can fire it later.
  const [captured, setCaptured] = React.useState<InstallEventLike | null>(null);
  React.useEffect(() => {
    if (props.installEvent !== undefined) return;
    function onBeforeInstall(event: Event): void {
      event.preventDefault();
      setCaptured(event as unknown as InstallEventLike);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, [props.installEvent]);
  const installEvent = props.installEvent !== undefined ? props.installEvent : captured;

  // Setting this device up for push: the Settings → Notifications ceremony (permission
  // first, then the worker and the subscription), handed to the server action.
  const registerDevice = React.useMemo(() => {
    if (!registerPushDevice) return undefined;
    return async (): Promise<RegisterDeviceOutcome> => {
      const outcome = await subscribeThisBrowser({
        container: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
        notification: typeof Notification !== "undefined" ? Notification : undefined,
        vapidPublicKey,
      });
      if (!outcome.ok) return outcome;
      return registerPushDevice(outcome.subscription);
    };
  }, [registerPushDevice, vapidPublicKey]);

  const controller = React.useMemo(
    () => createInstallPrompt({ userAgent, notification, installEvent, registerDevice, onChange: forceUpdate }),
    [userAgent, notification, installEvent, registerDevice],
  );

  const { platform, notificationPermission, deviceSetup } = controller.getState();

  // The notification prompt is platform-independent: it appears whenever notifications
  // are supported and the decision is still undecided (unless the page hides it), and
  // again after a failed device set-up so "try again" always has its control.
  const showNotificationPrompt =
    showNotifications &&
    notification !== undefined &&
    (notificationPermission === "default" || deviceSetup === "failed");

  return (
    <div data-install-prompt="" className="flex flex-col gap-4">
      {platform === "ios" && !standalone ? (
        <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-fg">
            <Share aria-hidden={true} className="h-5 w-5 shrink-0" />
            <h2 className="text-base font-medium">Add Warthog to your Home Screen</h2>
          </div>
          <p className="text-sm text-fg-muted">
            Tap the Share button at the bottom of the screen, then choose “Add to Home
            Screen”. Warthog opens like an app, straight from your Home Screen.
          </p>
        </section>
      ) : null}

      {platform === "android" && installEvent && !standalone ? (
        <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
          <p className="text-sm text-fg-muted">
            Add Warthog to your phone so it opens like an app, straight from your Home
            Screen.
          </p>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              void controller.promptInstall();
            }}
          >
            <Download aria-hidden={true} className="h-5 w-5 shrink-0" />
            Install Warthog
          </Button>
        </section>
      ) : null}

      {showNotificationPrompt ? (
        <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-fg">
            <Bell aria-hidden={true} className="h-5 w-5 shrink-0" />
            <h2 className="text-base font-medium">Stay in the loop</h2>
          </div>
          <p className="text-sm text-fg-muted">
            We’ll let you know when an agent needs your okay — like approving a payment or
            sharing your details. You decide what gets through, and you can turn this off
            any time.
          </p>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              void controller.enableNotifications();
            }}
          >
            Turn on notifications
          </Button>
        </section>
      ) : null}

      {showNotifications && deviceSetup !== undefined ? (
        <p
          role={deviceSetup === "done" ? "status" : "alert"}
          className="flex items-start gap-2 text-sm text-fg"
        >
          {deviceSetup === "done" ? (
            <CheckCircle2 aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          ) : (
            <AlertTriangle aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          )}
          {DEVICE_SETUP_COPY[deviceSetup]}
        </p>
      ) : null}
    </div>
  );
}

export default InstallPrompt;
