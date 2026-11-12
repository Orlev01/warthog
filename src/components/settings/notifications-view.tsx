"use client";

import { SmsDisclosure } from "../public/sms-disclosure";

import * as React from "react";
import { Bell, Smartphone, Send, ShieldCheck, Clock, Trash2, MessageSquareOff } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
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
  smsEnabled?: boolean;
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

// A divider row inside a panel: the item on the left, its one control on the right; the
// text wraps beside the control rather than pushing it onto a line of its own.
const ROW =
  "flex min-w-0 items-center justify-between gap-4 border-b border-line py-3 text-sm first:pt-0 last:border-0 last:pb-0 [overflow-wrap:anywhere]";

// A stacked divider row (a setting with its notes) and a checkbox with its whole label as
// the 44px target.
const ROW_ITEM = "flex min-w-0 flex-col gap-2 border-b border-line py-3 text-sm first:pt-0 last:border-0 last:pb-0";
const CHECK_LABEL = "flex min-h-11 items-center gap-3";

export function NotificationsView({
  devices,
  numbers,
  emailFallback = true,
  smsEnabled = true,
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
  // Text messages can only be sent to an enabled destination country (twilio.ts refuses
  // every number otherwise), so with none enabled the number form, the SMS alert switch and
  // their legal text would be a dead end: show one plain line instead (content-30).
  const smsAvailable = smsEnabled && smsCountries.length > 0;
  const smsCountryNames = smsCountries
    .map((code) => new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code)
    .join(", ");
  const noop = () => undefined;
  // One ceremony at a time: the ref drops a second tap before React has re-rendered.
  const [registering, setRegistering] = React.useState(false);
  const registeringRef = React.useRef(false);

  // Register THIS browser as a push device. The subscription can only be created on
  // the client, so this control runs the ceremony (`subscribeThisBrowser`: permission
  // first, then the worker, waiting until it is ACTIVE before subscribing — review fix
  // G5, the first tap used to fail) and hands the subscription to the
  // `registerPushDevice` server action. Every outcome is reported in plain words via a
  // `?notice=` redirect (never a silent no-op).
  async function handleRegisterDevice(): Promise<void> {
    if (!registerPushDevice || registeringRef.current) return;
    registeringRef.current = true;
    setRegistering(true);
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
    <>
      {/* ----- Push devices: register one or more devices to be reached on, and test them ----- */}
      <WorkspacePanel
        title="Push notifications"
        description="Get approval alerts on your phone or computer. Register each device you want them on."
        footer={
          <>
            <Button
              type="button"
              variant="primary"
              aria-disabled={registering || undefined}
              aria-busy={registering || undefined}
              onClick={() => {
                void handleRegisterDevice();
              }}
            >
              <Bell aria-hidden={true} className="h-4 w-4 shrink-0" />
              {registering ? "Setting up…" : "Register this device"}
            </Button>
            <ActionForm action={sendTestNotificationAction ?? noop} className="contents">
              <FormSubmit variant="secondary" disabled={!hasDevice} pendingLabel="Sending…">
                <Send aria-hidden={true} className="h-4 w-4 shrink-0" />
                Send a test notification
              </FormSubmit>
            </ActionForm>
            {hasDevice ? null : <span>Register a device first, so the test notification has somewhere to go.</span>}
          </>
        }
      >
        <div className="flex min-w-0 flex-col gap-4 [&>[data-install-prompt]:empty]:hidden">
          {/* Install guidance (iOS only delivers web push to an app added to the Home
              Screen); its own notification part is hidden — "Register this device" below
              already sets notifications up (review fix W4.1). */}
          <InstallPrompt showNotifications={false} />
          {hasDevice ? (
            <ul role="list" className="flex min-w-0 flex-col">
              {devices.map((device) => {
                const label = device.label ?? "Registered device";
                const isThisDevice = thisDevice !== null && device.fingerprint === thisDevice;
                return (
                  <li key={device.id} className={ROW}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-fg">{label}</span>
                      {isThisDevice ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted">
                          <Smartphone aria-hidden={true} className="h-3.5 w-3.5 shrink-0" />
                          This device
                        </span>
                      ) : null}
                    </span>
                    <ActionForm action={removePushDeviceAction ?? noop} className="shrink-0">
                      <input type="hidden" name="id" value={device.id} />
                      <FormSubmit variant="danger" size="sm" pendingLabel="Removing…" aria-label={`Remove ${label}`}>
                        <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
                        Remove
                      </FormSubmit>
                    </ActionForm>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              variant="inline"
              icon={Bell}
              heading="No devices registered yet."
              description="Register this device to get approval alerts on it."
            />
          )}
        </div>
      </WorkspacePanel>

      {/* ----- SMS: add and verify a mobile number with a 6-digit code ----- */}
      {smsAvailable ? (
        <WorkspacePanel
          title="Mobile number for text messages"
          description={`Get approval alerts by text if you don't open them in time. Available in ${smsCountryNames}. Text messages are optional.`}
          footer={<SmsDisclosure purpose="verification" />}
        >
          <div className="flex min-w-0 flex-col gap-4">
            {numbers.length > 0 ? (
              <ul role="list" className="flex min-w-0 flex-col">
                {numbers.map((number) => (
                  <li key={number.id} className="flex min-w-0 flex-col gap-3 border-b border-line py-3 text-sm first:pt-0 last:border-0 last:pb-0">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                      <span className="font-medium text-fg [overflow-wrap:anywhere]">{number.number}</span>
                      {number.verified ? (
                        <Badge tone="success" icon={ShieldCheck}>Verified</Badge>
                      ) : (
                        <Badge tone="neutral" icon={Clock}>Not verified</Badge>
                      )}
                    </div>
                    {number.verified ? null : (
                      <div className="flex min-w-0 flex-col gap-3 rounded-field bg-surface-muted p-3">
                        <p className="text-fg-muted">If your text arrives, enter its 6-digit code, then verify.</p>
                        <ActionForm
                          action={verifyMobileNumberAction ?? noop}
                          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end"
                        >
                          <input type="hidden" name="id" value={number.id} />
                          <Field
                            label="Verification code"
                            name="code"
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            width="short"
                          />
                          <FormSubmit variant="secondary" pendingLabel="Verifying…">
                            Verify
                          </FormSubmit>
                        </ActionForm>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Add a new number: type it, then request its verification code. */}
            <ActionForm action={addMobileNumberAction ?? noop} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
              <Field
                label="Mobile number"
                hint="Start with + and your country code. We'll text you a 6-digit code to check it."
                name="number"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                className="sm:flex-1"
              />
              <FormSubmit variant="secondary" pendingLabel="Sending code…">
                <Send aria-hidden={true} className="h-4 w-4 shrink-0" />
                Send code
              </FormSubmit>
            </ActionForm>
          </div>
        </WorkspacePanel>
      ) : null}

      {/* ----- Fallback preferences: what happens when an alert isn't opened in time ----- */}
      <ActionForm action={saveNotificationPrefsAction ?? noop} className="contents">
        <WorkspacePanel
          title="If you miss an alert"
          description="When an approval isn't opened in time, Warthog follows up another way."
          footer={
            <FormSubmit variant="secondary" pendingLabel="Saving…">
              Save preferences
            </FormSubmit>
          }
        >
          <PendingFormFields>
            <ul role="list" className="flex min-w-0 flex-col">
              <li className={ROW_ITEM}>
                <label className={CHECK_LABEL}>
                  <input type="checkbox" name="emailFallback" defaultChecked={emailFallback} className="h-4 w-4 shrink-0" />
                  <span className="text-fg">Also send fallback alerts by email</span>
                </label>
              </li>
              {smsAvailable ? (
                <li className={ROW_ITEM}>
                  <label className={CHECK_LABEL}>
                    <input
                      type="checkbox"
                      name="smsFallback"
                      defaultChecked={smsFallback}
                      aria-describedby="notifications-sms-fallback-note"
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="text-fg">Send approval alerts by SMS to my verified number</span>
                  </label>
                  <div className="flex min-w-0 flex-col gap-2 pl-7 text-sm text-fg-muted">
                    <p id="notifications-sms-fallback-note">
                      Off until you turn it on. Turn it off and save to stop future alert texts. It
                      doesn&apos;t stop a verification text you ask for.
                    </p>
                    <SmsDisclosure purpose="alerts" />
                  </div>
                </li>
              ) : (
                <li className={ROW_ITEM}>
                  {/* Keep a saved SMS-alert choice as it is: hiding the switch must not
                      quietly turn it off the next time these preferences are saved. */}
                  {smsEnabled && smsFallback ? <input type="hidden" name="smsFallback" value="on" /> : null}
                  <EmptyState
                    variant="inline"
                    icon={MessageSquareOff}
                    heading="Text message alerts aren't available yet."
                    description="You can get approval alerts by push notification and email, and you can always approve in the app."
                  />
                </li>
              )}
              <li className={ROW_ITEM}>
                <Field
                  label="Fallback delay (minutes)"
                  hint="How long Warthog waits for an approval to be opened before following up: 1 to 30 minutes."
                  name="fallbackDelayMinutes"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={30}
                  width="code"
                  defaultValue={fallbackDelayMinutes}
                />
              </li>
            </ul>
          </PendingFormFields>
        </WorkspacePanel>
      </ActionForm>
    </>
  );
}

export default NotificationsView;
