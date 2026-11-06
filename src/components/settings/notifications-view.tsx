"use client";

import * as React from "react";
import { Bell, Smartphone, Mail, Send, ShieldCheck, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";

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

// A registered push device (StoredPushSubscription-shaped): its id and an optional
// human label.
export type NotificationsViewDevice = { id: string; label?: string };

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
  // Form-submit server actions for the number/preferences/test controls.
  addMobileNumberAction?: NotificationsFormAction;
  verifyMobileNumberAction?: NotificationsFormAction;
  saveNotificationPrefsAction?: NotificationsFormAction;
  sendTestNotificationAction?: NotificationsFormAction;
};

// The screen a register outcome redirects back to, with a `?notice=` code the page
// maps to plain-words copy (the same notice channel the form actions use, so the
// client ceremony never fails silently).
const SCREEN = "/settings/notifications";

// Decode a base64url VAPID public key into the byte array PushManager.subscribe wants
// as its applicationServerKey (browsers accept only a BufferSource here, not the
// string). Standard Web Push conversion.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
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
  fallbackDelayMinutes = 2,
  vapidPublicKey,
  registerPushDevice,
  addMobileNumberAction,
  verifyMobileNumberAction,
  saveNotificationPrefsAction,
  sendTestNotificationAction,
}: NotificationsViewProps) {
  const hasDevice = devices.length > 0;

  // Register THIS browser as a push device. The subscription can only be created on
  // the client (service worker + PushManager), so this control runs the ceremony and
  // then hands the subscription to the `registerPushDevice` server action. Every
  // outcome — success, a browser that can't do push, or a failure — is reported in
  // plain words via a `?notice=` redirect (never a silent no-op).
  async function handleRegisterDevice(): Promise<void> {
    if (!registerPushDevice) return;
    const go = (notice: string): void => {
      window.location.assign(`${SCREEN}?notice=${notice}`);
    };
    try {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !vapidPublicKey) {
        go("push_unavailable");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const json = subscription.toJSON();
      const endpoint = json.endpoint;
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!endpoint || !p256dh || !auth) {
        go("register_failed");
        return;
      }
      const result = await registerPushDevice({ endpoint, keys: { p256dh, auth } });
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
        {hasDevice ? (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => (
              <li
                key={device.id}
                className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-fg"
              >
                {device.label ?? "This device"}
              </li>
            ))}
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
                        Enter the 6-digit code we texted you, then verify.
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
            placeholder="+61 400 000 000"
            className="sm:flex-1"
          />
          <Button type="submit" variant="secondary" className="sm:self-stretch">
            <Send aria-hidden={true} className="h-4 w-4 shrink-0" />
            Send code
          </Button>
        </form>
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
