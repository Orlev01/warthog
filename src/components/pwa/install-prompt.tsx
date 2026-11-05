"use client";

import * as React from "react";
import { Bell, Download, Share } from "lucide-react";

import { Button } from "@/components/ui/button";

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
// the component reads `navigator.userAgent`, the global `Notification` and the captured
// `beforeinstallprompt` event; a test injects them, so detection and behaviour are
// deterministic with no globals.

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

export interface InstallPromptDeps {
  readonly userAgent: string; // navigator.userAgent — picks the platform
  readonly notification?: NotificationLike; // absent ⇒ notifications unsupported
  readonly installEvent?: InstallEventLike | null; // the captured Android install event
  // Optional: the component wires this to re-render after each state change. The
  // controller works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface InstallPromptState {
  readonly platform: InstallPlatform;
  readonly notificationPermission: NotificationPermission;
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

  function getState(): InstallPromptState {
    return { platform, notificationPermission };
  }

  // The user action. With no Notification API there is nothing to ask — fail gracefully
  // (resolve), never throw. A rejected request (e.g. outside a user gesture) leaves the
  // decision undecided so the prompt stays, rather than crashing the control.
  async function enableNotifications(): Promise<void> {
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

export interface InstallPromptProps {
  readonly userAgent?: string; // defaults to navigator.userAgent in the browser
  readonly notification?: NotificationLike; // defaults to the global Notification
  readonly installEvent?: InstallEventLike | null; // defaults to the captured event
}

export function InstallPrompt(props: InstallPromptProps): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);

  const userAgent =
    props.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const browserNotif = React.useMemo(browserNotification, []);
  const notification = props.notification ?? browserNotif;

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

  const controller = React.useMemo(
    () => createInstallPrompt({ userAgent, notification, installEvent, onChange: forceUpdate }),
    [userAgent, notification, installEvent],
  );

  const { platform, notificationPermission } = controller.getState();

  // The notification prompt is platform-independent: it appears whenever notifications
  // are supported and the decision is still undecided.
  const showNotificationPrompt = notification !== undefined && notificationPermission === "default";

  return (
    <div className="flex flex-col gap-4">
      {platform === "ios" ? (
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

      {platform === "android" && installEvent ? (
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
    </div>
  );
}

export default InstallPrompt;
