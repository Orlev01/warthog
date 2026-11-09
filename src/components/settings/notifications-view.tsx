"use client";

import { SmsDisclosure } from "../public/sms-disclosure";

import * as React from "react";
import { Bell, Smartphone, Mail, Send, ShieldCheck, Clock, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { endpointFingerprint, subscribeThisBrowser } from "./push-subscribe";
import { InstallPrompt } from "@/components/pwa/install-prompt";

// E12-S18 — Notification settings view component (design §10 Notifications;
// brief "Notification settings").
//
// The notification settings screen is where a person sets up HOW they are reached.
// It lets them register one or more devices for push notifications, add and verify a
// mobile number for the SMS fallback with a 6-digit code, choose whether fallback
// messages also go by email (on by default), send a test notification, and choose the
// fallback delay (default 2 minutes, adjustable 1–30 minutes).
//
// This is the PURE, prop-driven VIEW (a Client Component in the app): it renders the
// screen from its props so it can be pinned without a browser, a session or any server
// plumbing. The real plumbing — registering a push subscription, sending the
// verification SMS, persisting the preferences, firing the test push — lives in the
// server composition root and a sibling actions module wired by a LATER task; the
// controls here are native affordances whose initial state is driven by the props
// (the registered devices, the mobile numbers with their verified flag, and the two
// saved preferences), exactly the precedent the sibling consent/rules views set.
//
// Because "no dead controls" is the law, the "send a test notification" control is
// DISABLED with a stated reason when there is no registered device to push to — never
// a live button that does nothing. Colour comes from the design tokens (globals.css) —
// never a raw hex.

// A registered push device (StoredPushSubscription-shaped): its id, a plain label (when it
// was registered) and a one-way fingerprint of its endpoint. The browser fingerprints its
// own current subscription and marks the matching row "This device" (review fix G5: every
// row used to read "This device", even a phone listed on a laptop).
export type NotificationsViewDevice = { id: string; label?: string; fingerprint?: string };

// A person's mobile number (StoredMobileNumber-shaped): its id, the number, and
// whether it has been verified.
export type NotificationsViewNumber = { id: string; number: string; verified: boolean };

// A server action's outcome, as the register ceremony reads it back (the same
// { ok } | { ok, reason } shape every notifications action returns).
export type NotificationsViewActionResult = { ok: true } | { ok: false; reason: string };

// A form-submit server action the page hands down to wire a control (add a number,
// verify a code, save preferences, send a test). The browser posts the control's
// fields as FormData; the action reads them, acts member-scoped to the session
// person, and redirects back with a `?notice=` code the page turns into copy.
export type NotificationsFormAction = (formData: FormData) => void | Promise<void>;

export type NotificationsViewProps = {
  // the person's registered push devices. When EMPTY, the test-notification control is
  // disabled with a stated reason (nothing to push to).
  devices: ReadonlyArray<NotificationsViewDevice>;
  // the person's mobile numbers; a verified one shows its verified state, an unverified
  // one offers a 6-digit code field + a live Verify control.
  numbers: ReadonlyArray<NotificationsViewNumber>;
  // whether fallback messages also go by email. Defaults ON (brief default).
  emailFallback?: boolean;
  smsFallback?: boolean;
  smsCountries?: readonly string[];
  // the fallback delay in minutes, bounded to the inclusive 1–30 range. Defaults to 2
  // (brief default).
  fallbackDelayMinutes?: number;

  // --- wiring (the page passes these in the running app; omitted in render tests) ---
  // The VAPID application-server public key (config, a PUBLIC value — never a secret),
  // used by the register ceremony to subscribe this browser for Web Push.
  vapidPublicKey?: string;
  // Register this browser as a push device: the client runs the Web Push subscription
  // ceremony (service worker + PushManager) and hands the subscription to this server
  // action, which stores it for the session person.
  registerPushDevice?: (input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }) => Promise<NotificationsViewActionResult>;
  // Form-submit server actions for the device/number/preferences/test controls.
  removePushDeviceAction?: NotificationsFormAction;
  addMobileNumberAction?: NotificationsFormAction;
  verifyMobileNumberAction?: NotificationsFormAction;
  saveNotificationPrefsAction?: NotificationsFormAction;
  sendTestNotificationAction?: NotificationsFormAction;
};

// The screen a register outcome redirects back to, with a `?notice=` code the page
// maps to plain-words copy (the same notice channel the form actions use, so the
// client ceremony never fails silently).
const SCREEN = "/settings/notifications";

// The fingerprint of THIS browser's current push subscription, read after mount (the
// server render and the first client render both see null, so there is no hydration
// mismatch). Null when the browser has no service worker or no subscription.
function useThisDeviceFingerprint(): string | null {
  const [fingerprint, setFingerprint] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then(async (subscription) => {
        if (!subscription || cancelled) return;
        const value = await endpointFingerprint(subscription.endpoint);
        if (!cancelled) setFingerprint(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return fingerprint;
}

function SectionHeading({ icon: Icon, children }: { icon: typeof Bell; children: React.ReactNode }) {
  return (
    <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-fg">
      <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
      {children}
    </h2>
  );
}

export function NotificationsView({
  devices,
  numbers,
  emailFallback = true,
  smsFallback = false,
  smsCountries = [],
  fallbackDelayMinutes = 2,
  vapidPublicKey,
  registerPushDevice,
  removePushDeviceAction,
  addMobileNumberAction,
  verifyMobileNumberAction,
  saveNotificationPrefsAction,
  sendTestNotificationAction,
}: NotificationsViewProps) {
  const hasDevice = devices.length > 0;
  const thisDevice = useThisDeviceFingerprint();

  // Register THIS browser as a push device. The subscription can only be created on
  // the client, so this control runs the ceremony (`subscribeThisBrowser`: permission
  // first, then the worker, waiting until it is ACTIVE before subscribing — review fix
  // G5, the first tap used to fail) and hands the subscription to the
  // `registerPushDevice` server action. Every outcome is reported in plain words via a
  // `?notice=` redirect (never a silent no-op).
  async function handleRegisterDevice(): Promise<void> {
    if (!registerPushDevice) return;
    const go = (notice: string): void => {
      window.location.assign(`${SCREEN}?notice=${notice}`);
    };
    try {
      const outcome = await subscribeThisBrowser({
        container:
          typeof navigator !== "undefined" && "serviceWorker" in navigator
            ? navigator.serviceWorker
            : undefined,
        notification: typeof Notification !== "undefined" ? Notification : undefined,
        vapidPublicKey,
      });
      if (!outcome.ok) {
        go(outcome.reason);
        return;
      }
      const result = await registerPushDevice(outcome.subscription);
      go(result.ok ? "device_registered" : "invalid_request");
    } catch {
      go("register_failed");
    }
  }

  return (
    <section className="flex flex-col gap-8">
      {/* ----- Push devices: register one or more devices to be reached on ----- */}
      <div className="flex flex-col gap-3">
        <SectionHeading icon={Bell}>Push notifications</SectionHeading>
        {/* Install guidance (iOS only delivers web push to an app added to the Home
            Screen); its own notification part is hidden — "Register this device" below
            already sets notifications up (review fix W4.1). */}
        <InstallPrompt showNotifications={false} />
        {hasDevice ? (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => {
              const label = device.label ?? "Registered device";
              const isThisDevice = thisDevice !== null && device.fingerprint === thisDevice;
              return (
                <li
                  key={device.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm text-fg"
                >
                  <span className="flex flex-col gap-0.5">
                    <span>{label}</span>
                    {isThisDevice ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted">
                        <Smartphone aria-hidden={true} className="h-3.5 w-3.5 shrink-0" />
                        This device
                      </span>
                    ) : null}
                  </span>
                  <form action={removePushDeviceAction}>
                    <input type="hidden" name="id" value={device.id} />
                    <Button type="submit" variant="secondary" aria-label={`Remove ${label}`}>
                      <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
                      Remove
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No devices registered yet.</p>
        )}
        <Button
          type="button"
          variant="primary"
          className="self-start"
          onClick={() => {
            void handleRegisterDevice();
          }}
        >
          <Bell aria-hidden={true} className="h-4 w-4 shrink-0" />
          Register this device
        </Button>
      </div>

      {/* ----- SMS fallback: add and verify a mobile number with a 6-digit code ----- */}
      <div className="flex flex-col gap-3">
        <SectionHeading icon={Smartphone}>Mobile number for SMS fallback</SectionHeading>
        <p className="text-sm text-fg-muted">
          Use + and your country code. SMS is optional and depends on your country and mobile network.
          {smsCountries.length ? ` Currently enabled: ${smsCountries.map((code) => new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code).join(", ")}.` : " No SMS destinations are currently enabled."}
          {" "}Email, supported push notifications and in-app approvals remain available.
          Requesting a code sends your number to Twilio for validation and one verification text.
        </p>

        {numbers.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {numbers.map((number) => (
              <li key={number.id}>
                <Card className="flex flex-col gap-3">
                  <p className="font-medium text-fg">{number.number}</p>
                  {number.verified ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
                      <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
                      Verified
                    </span>
                  ) : (
                    <>
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted">
                        <Clock aria-hidden={true} className="h-4 w-4 shrink-0" />
                        Not verified
                      </span>
                      <p className="text-sm text-fg-muted">
                        If your text arrives, enter its 6-digit code, then verify.
                      </p>
                      <form
                        action={verifyMobileNumberAction}
                        className="flex flex-col gap-3 sm:flex-row sm:items-end"
                      >
                        <input type="hidden" name="id" value={number.id} />
                        <Field
                          label="Verification code"
                          name="code"
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="123456"
                          className="sm:flex-1"
                        />
                        <Button type="submit" variant="secondary" className="sm:self-stretch">
                          Verify
                        </Button>
                      </form>
                    </>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Add a new number: type it, then request its verification code. */}
        <form
          action={addMobileNumberAction}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <Field
            label="Mobile number"
            name="number"
            type="tel"
            inputMode="tel"
            placeholder="+ country code and number"
            className="sm:flex-1"
          />
          <Button type="submit" variant="secondary" className="sm:self-stretch">
            <Send aria-hidden={true} className="h-4 w-4 shrink-0" />
            Send code
          </Button>
        </form>
        <SmsDisclosure purpose="verification" />
      </div>

      {/* ----- Fallback preferences: email fallback + the delay before it fires ----- */}
      <form action={saveNotificationPrefsAction} className="flex flex-col gap-3">
        <SectionHeading icon={Mail}>Fallback</SectionHeading>

        <label className="flex items-center gap-3 rounded-card border border-line bg-surface p-3">
          <input
            type="checkbox"
            name="emailFallback"
            defaultChecked={emailFallback}
            className="h-4 w-4 accent-accent"
          />
          <span className="text-fg">Also send fallback alerts by email</span>
        </label>

        <label className="flex items-center gap-3 rounded-card border border-line bg-surface p-3">
          <input type="checkbox" name="smsFallback" defaultChecked={smsFallback} className="h-4 w-4 accent-accent" />
          <span className="text-fg">Send approval alerts by SMS to my verified number</span>
        </label>
        <p className="text-sm text-fg-muted">
          SMS alerts are off until you enable them. Turn this off and save to stop future SMS alerts.
          This setting does not prevent a verification text you explicitly request.
        </p>
        <SmsDisclosure purpose="alerts" />

        <Field
          label="Fallback delay (minutes)"
          name="fallbackDelayMinutes"
          type="number"
          inputMode="numeric"
          min={1}
          max={30}
          defaultValue={fallbackDelayMinutes}
        />
        <p className="text-sm text-fg-muted">
          How long Warthog waits for a push to be seen before falling back to SMS (1–30
          minutes).
        </p>
        <Button type="submit" variant="secondary" className="self-start">
          Save preferences
        </Button>
      </form>

      {/* ----- Send a test notification: live with a device, disabled WITH A REASON
               when none is registered (no dead controls). ----- */}
      <div className="flex flex-col gap-2">
        <SectionHeading icon={Send}>Test notification</SectionHeading>
        {hasDevice ? null : (
          <p className="text-sm text-fg-muted">
            Register a device above before you can send a test notification — there is
            nowhere to send it yet.
          </p>
        )}
        <form action={sendTestNotificationAction}>
          <Button type="submit" variant="secondary" disabled={!hasDevice} className="self-start">
            <Send aria-hidden={true} className="h-4 w-4 shrink-0" />
            Send a test notification
          </Button>
        </form>
      </div>
    </section>
  );
}

export default NotificationsView;
