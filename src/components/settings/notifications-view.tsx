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
};

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
}: NotificationsViewProps) {
  const hasDevice = devices.length > 0;

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
        <Button type="button" variant="primary" className="self-start">
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
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <Field
                          label="Verification code"
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="123456"
                          className="sm:flex-1"
                        />
                        <Button type="button" variant="secondary" className="sm:self-stretch">
                          Verify
                        </Button>
                      </div>
                    </>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Add a new number: type it, then request its verification code. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field
            label="Mobile number"
            type="tel"
            inputMode="tel"
            placeholder="+61 400 000 000"
            className="sm:flex-1"
          />
          <Button type="button" variant="secondary" className="sm:self-stretch">
            <Send aria-hidden={true} className="h-4 w-4 shrink-0" />
            Send code
          </Button>
        </div>
      </div>

      {/* ----- Fallback preferences: email fallback + the delay before it fires ----- */}
      <div className="flex flex-col gap-3">
        <SectionHeading icon={Mail}>Fallback</SectionHeading>

        <label className="flex items-center gap-3 rounded-card border border-line bg-surface p-3">
          <input type="checkbox" defaultChecked={emailFallback} className="h-4 w-4 accent-accent" />
          <span className="text-fg">Also send fallback alerts by email</span>
        </label>

        <Field
          label="Fallback delay (minutes)"
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
      </div>

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
        <Button type="button" variant="secondary" disabled={!hasDevice} className="self-start">
          <Send aria-hidden={true} className="h-4 w-4 shrink-0" />
          Send a test notification
        </Button>
      </div>
    </section>
  );
}

export default NotificationsView;
