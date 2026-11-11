import { formatAccountTime } from "@/domain/display-time";
import * as React from "react";

import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Wordmark } from "../shell/wordmark";
import { withReturnPath } from "../../server/auth/return-path";

// Auth page views (task E04-S12) — the Signup, Signin, Recover and Device screens
// as plain, step-driven PRESENTATION components. They render from props alone: no
// session, no browser, no protocol machinery — so the thin entry files
// (signup / signin / device / recover page.tsx) stay thin and compose these, and a
// render test can pin the exact plain copy a person reads at each step.
//
// Everything on these primary screens is said in plain Australian English — the
// only "technical" words are the brief's own plain vocabulary ("passkey",
// "recovery code", "authenticator", "code"); no protocol/security jargon reaches
// them (brief design_ux.copy; constitution INV-22; design §5). Colour, spacing and
// radius come from the design tokens (globals.css) via the Button/Field primitives.

// --- shared layout ---------------------------------------------------------

// One screen: a page heading, an optional plain lead sentence, then the step body. The
// screen is the page's <main> landmark, and step errors are rendered with role="alert"
// so a screen reader announces them when they appear (WCAG 4.1.3).
function AuthScreen({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-8 sm:px-6">
      <Wordmark href="/" />
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {lead ? <p className="text-sm text-fg-muted">{lead}</p> : null}
      {children}
    </main>
  );
}

// A raw base32 recovery code shown in groups of four ("ABCD EFGH …", design §4.2), so it
// is easy to copy by hand; the server accepts it back with or without the spaces. A code
// that already carries separators is shown as given.
function groupRecoveryCode(code: string | undefined): string | undefined {
  if (code === undefined || !/^[A-Z2-7]{8,}$/.test(code)) return code;
  return code.match(/.{1,4}/g)!.join(" ");
}

// The other ways in, as plain links under a screen's main action: sign-in offers
// sign-up, account recovery and signing in by approving from another device; the other
// screens lead back to sign-in. Each link carries the return path along (when there is
// one), so moving between auth screens never loses where the person was going.
interface AuthLink {
  readonly href: string;
  readonly label: string;
}

function AuthLinks({ links, returnTo }: { links: readonly AuthLink[]; returnTo?: string }) {
  return (
    <nav aria-label="Other ways to sign in">
      <ul className="flex flex-col gap-2 text-sm">
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={withReturnPath(link.href, returnTo)}
              className="inline-flex min-h-11 items-center rounded-card text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const SIGNIN_LINKS: readonly AuthLink[] = [
  { href: "/signup", label: "New here? Create an account" },
  { href: "/recover", label: "Lost your passkey? Recover your account" },
  { href: "/device", label: "Sign in by approving from another device" },
  { href: "/reset", label: "Lost everything? Reset your account" },
  { href: "/reset/setup", label: "Reset finished? Set up a new passkey" },
];

const SIGNUP_LINKS: readonly AuthLink[] = [
  { href: "/signin", label: "Already have an account? Sign in" },
];

const RECOVER_LINKS: readonly AuthLink[] = [
  { href: "/signin", label: "Found your passkey? Sign in" },
  { href: "/reset", label: "Lost your recovery code too? Reset your account" },
];

const RESET_LINKS: readonly AuthLink[] = [
  { href: "/reset/setup", label: "Reset finished? Set up a new passkey" },
  { href: "/signin", label: "Found your passkey? Sign in" },
  { href: "/recover", label: "Still have your recovery code? Recover your account" },
];

const RESET_SETUP_LINKS: readonly AuthLink[] = [
  { href: "/signin", label: "Back to sign in" },
  { href: "/reset", label: "Haven't reset yet? Reset your account" },
];

const DEVICE_LINKS: readonly AuthLink[] = [{ href: "/signin", label: "Back to sign in" }];

// The read-only, shown-once recovery code, a tick to confirm it is saved, and the
// gated Continue. The code is rendered as plain text (never prefilled into an editable
// input) so it is never carried as a form value — the person reads it and writes it
// down. Continue stays disabled until the person ticks "I've saved it". Without the
// optional wiring (the static render tests) the tick and Continue are inert copy.
function SaveRecoveryCode({
  code,
  savedConfirmed = false,
  working = false,
  onSavedConfirmedChange,
  onContinue,
  error,
}: {
  code?: string;
  savedConfirmed?: boolean;
  working?: boolean;
  onSavedConfirmedChange?: (value: boolean) => void;
  onContinue?: () => void;
  error?: string;
}) {
  const checkboxId = React.useId();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-fg">Your recovery code</span>
        <p className="rounded-card border border-line bg-surface-muted px-3 py-3 text-center font-mono text-lg tracking-widest text-fg">
          {groupRecoveryCode(code)}
        </p>
      </div>
      <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-line accent-accent"
          checked={savedConfirmed}
          disabled={working}
          onChange={(event) => onSavedConfirmedChange?.(event.target.checked)}
        />
        <span>I&apos;ve saved it</span>
      </label>
      <Button type="button" variant="primary" disabled={!savedConfirmed} aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50" onClick={() => { if (!working && savedConfirmed) onContinue?.(); }}>
        Continue
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// --- sign-up ---------------------------------------------------------------

export type SignupStep = "details" | "code" | "passkey" | "authenticator" | "recovery";

// SignupView renders from props alone. The optional interactive wiring is supplied by
// the client sign-up flow (E04-S24) to drive the screen; when it is omitted the view
// renders as the static copy the render tests pin.
export interface SignupViewProps {
  step: SignupStep;
  working?: boolean;
  authenticatorSecret?: string;
  authenticatorQr?: string;
  onUseAuthenticatorApp?: () => void;
  recoveryCode?: string;
  name?: string;
  email?: string;
  code?: string;
  error?: string;
  savedConfirmed?: boolean;
  onNameChange?: (value: string) => void;
  onEmailChange?: (value: string) => void;
  onCodeChange?: (value: string) => void;
  onSavedConfirmedChange?: (value: boolean) => void;
  onSubmit?: () => void;
  onCreatePasskey?: () => void;
  onConfirm?: () => void;
  // Where to go after signing in (a validated relative path), carried on the links
  // to the other auth screens.
  returnTo?: string;
}

export function SignupView({
  step,
  working = false,
  authenticatorSecret,
  authenticatorQr,
  onUseAuthenticatorApp,
  recoveryCode,
  name,
  email,
  code,
  error,
  savedConfirmed,
  onNameChange,
  onEmailChange,
  onCodeChange,
  onSavedConfirmedChange,
  onSubmit,
  onCreatePasskey,
  onConfirm,
  returnTo,
}: SignupViewProps) {
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!working) onSubmit?.();
  };
  switch (step) {
    case "details":
      return (
        <AuthScreen title="Create your account" lead="Tell us a little about you to get started.">
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Field
              label="Your name"
              name="name"
              type="text"
              required disabled={working}
              autoComplete="name"
              value={name ?? ""}
              onChange={(event) => onNameChange?.(event.target.value)}
            />
            <Field
              label="Email address"
              name="email"
              type="email"
              required disabled={working}
              autoComplete="email"
              value={email ?? ""}
              onChange={(event) => onEmailChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
              Continue
            </Button>
          </form>
          <AuthLinks links={SIGNUP_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
    case "code":
      return (
        <AuthScreen
          title="Check your email"
          lead="Enter the code we emailed you to confirm it's your address."
        >
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Field
              label="Your code"
              name="code"
              type="text"
              required disabled={working}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
              Continue
            </Button>
          </form>
        </AuthScreen>
      );
    case "passkey":
      return (
        <AuthScreen
          title="Set up a passkey"
          lead="A passkey lets you sign in with your fingerprint, face or device PIN — there's no password to remember."
        >
          <Button type="button" variant="primary" onClick={() => { if (!working) onCreatePasskey?.(); }} aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
            Create a passkey
          </Button>
          <Button type="button" variant="secondary" onClick={() => { if (!working) onUseAuthenticatorApp?.(); }} aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
            Use an authenticator app
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </AuthScreen>
      );
    case "authenticator":
      return (
        <AuthScreen title="Set up your authenticator app" lead="Scan this code with your authenticator app, or enter the setup key manually. Then enter the six-digit code it shows.">
          {authenticatorQr ? <img src={authenticatorQr} alt="Authenticator app setup code" width={256} height={256} className="h-auto max-w-full self-center" /> : null}
          <p className="break-all rounded-card bg-surface-muted p-3 font-mono text-sm">{authenticatorSecret}</p>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Field label="Authenticator app code" name="totp" type="text" inputMode="numeric"
              autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} disabled={working}
              value={code ?? ""} onChange={(event) => onCodeChange?.(event.target.value)} error={error} />
            <Button type="submit" variant="primary" aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">Confirm authenticator app</Button>
          </form>
          <a href="/signup" className="text-sm text-fg-muted underline">Start signup again</a>
        </AuthScreen>
      );
    case "recovery":
      return (
        <AuthScreen
          title="Save your recovery code"
          lead="Write this code down and keep it somewhere safe. It's the way back in if you lose your sign-in methods, and we'll only show it once."
        >
          <SaveRecoveryCode
            code={recoveryCode}
            working={working}
            savedConfirmed={savedConfirmed}
            onSavedConfirmedChange={onSavedConfirmedChange}
            onContinue={onConfirm}
            error={error}
          />
        </AuthScreen>
      );
  }
}

// --- sign-in ---------------------------------------------------------------

export type SigninStep = "passkey" | "email" | "email-code" | "code";

// SigninView renders from props alone. The optional interactive wiring is supplied by
// the client sign-in flow (E04-S25) to drive the screen; when it is omitted the view
// renders as the static copy the render tests pin. The passkey step collects the email
// (begin-passkey needs it) and offers the "use my authenticator app instead" path to
// the code step.
export interface SigninViewProps {
  step: SigninStep;
  email?: string;
  code?: string;
  error?: string;
  busy?: boolean;
  onEmailChange?: (value: string) => void;
  onCodeChange?: (value: string) => void;
  onPasskey?: () => void;
  onUseAuthenticatorApp?: () => void;
  onSubmitCode?: () => void;
  // Where to go after signing in (a validated relative path), carried on the links
  // to the other auth screens.
  returnTo?: string;
}

export function SigninView({
  step,
  email,
  code,
  error,
  busy,
  onEmailChange,
  onCodeChange,
  onPasskey,
  onUseAuthenticatorApp,
  onSubmitCode,
  returnTo,
}: SigninViewProps) {
  switch (step) {
    case "passkey":
      return (
        <AuthScreen
          title="Welcome back"
          lead="Enter your email and use your passkey to sign in — your fingerprint, face or device PIN."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onPasskey?.();
            }}
          >
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              disabled={busy}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Signing in…" : "Sign in with your passkey"}
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="button" variant="secondary" disabled={busy} onClick={onUseAuthenticatorApp}>
            Use my authenticator app instead
          </Button>
          <AuthLinks links={SIGNIN_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
    case "email":
    case "email-code":
    case "code":
      return (
        <AuthScreen
          title={step === "email" ? "Check your email first" : step === "email-code" ? "Enter your email code" : "Sign in with a code"}
          lead={step === "email" ? "We'll send a code to your email, then ask for the code from your authenticator app."
            : step === "email-code" ? "Enter the six-digit code from your latest Warthog email."
            : "Your email is verified. Enter the code from your authenticator app."}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitCode?.();
            }}
          >
            {step === "email" ? <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              disabled={busy}
            /> : <p className="text-sm text-fg-muted">{email}</p>}
            {step !== "email" ? <Field
              label={step === "email-code" ? "Email code" : "Authenticator code"}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
              disabled={busy}
            /> : null}
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : step === "email" ? "Send email code" : step === "email-code" ? "Verify email" : "Sign in"}
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {step !== "email" ? <Button type="button" variant="secondary" disabled={busy} onClick={onUseAuthenticatorApp}>Start again</Button> : null}
          <AuthLinks links={SIGNIN_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
  }
}

// --- recover (after losing every passkey) ----------------------------------

export type RecoverStep = "identify" | "email-code" | "recovery-code" | "passkey" | "new-recovery";

// RecoverView renders from props alone. The optional interactive wiring is supplied by
// the client recovery flow (E04-S33) to drive the screen; when it is omitted the view
// renders as the static copy the render tests pin. `recoveryCode` is the NEW shown-once
// replacement code (new-recovery step); `recoveryCodeValue` is the existing code the
// person types at the recovery-code step; `emailCode` is the one-time code from the
// email identify sent (email-code step).
export interface RecoverViewProps {
  busy?: boolean;
  step: RecoverStep;
  recoveryCode?: string;
  email?: string;
  emailCode?: string;
  recoveryCodeValue?: string;
  error?: string;
  savedConfirmed?: boolean;
  onEmailChange?: (value: string) => void;
  onEmailCodeChange?: (value: string) => void;
  onRecoveryCodeChange?: (value: string) => void;
  onSavedConfirmedChange?: (value: boolean) => void;
  onSubmitIdentify?: () => void;
  onSubmitEmailCode?: () => void;
  onSubmitRecoveryCode?: () => void;
  onCreatePasskey?: () => void;
  onConfirm?: () => void;
  // Where to go after signing in (a validated relative path), carried on the links
  // to the other auth screens.
  returnTo?: string;
}

export function RecoverView({
  step,
  busy,
  recoveryCode,
  email,
  emailCode,
  recoveryCodeValue,
  error,
  savedConfirmed,
  onEmailChange,
  onEmailCodeChange,
  onRecoveryCodeChange,
  onSavedConfirmedChange,
  onSubmitIdentify,
  onSubmitEmailCode,
  onSubmitRecoveryCode,
  onCreatePasskey,
  onConfirm,
  returnTo,
}: RecoverViewProps) {
  switch (step) {
    case "identify":
      return (
        <AuthScreen
          title="Recover your account"
          lead="First, let's check it's you. Enter your email and we'll send you a code."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitIdentify?.();
            }}
          >
            <Field
              disabled={busy}
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Send me a code"}
            </Button>
          </form>
          <AuthLinks links={RECOVER_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
    case "email-code":
      return (
        <AuthScreen
          title="Check your email"
          lead="If there's an account for that address, we've emailed it a code. Enter it here."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitEmailCode?.();
            }}
          >
            <Field
              disabled={busy}
              label="Your code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={emailCode}
              onChange={(event) => onEmailCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Continue"}
            </Button>
          </form>
        </AuthScreen>
      );
    case "recovery-code":
      return (
        <AuthScreen
          title="Enter your recovery code"
          lead="Enter the recovery code you saved when you first set up your account."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitRecoveryCode?.();
            }}
          >
            <Field
              disabled={busy}
              label="Recovery code"
              name="recoveryCode"
              type="text"
              autoComplete="off"
              value={recoveryCodeValue}
              onChange={(event) => onRecoveryCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Continue"}
            </Button>
          </form>
        </AuthScreen>
      );
    case "passkey":
      return (
        <AuthScreen
          title="Set up a new passkey"
          lead="Now create a new passkey so you can sign in on this device from now on."
        >
          <Button type="button" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onCreatePasskey?.(); }}>
            {busy ? "Please wait…" : "Create a passkey"}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </AuthScreen>
      );
    case "new-recovery":
      return (
        <AuthScreen
          title="Save your new recovery code"
          lead="Here's your new recovery code — your old one no longer works. Write it down and keep it safe, and we'll only show it once."
        >
          <SaveRecoveryCode
            working={busy}
            code={recoveryCode}
            savedConfirmed={savedConfirmed}
            onSavedConfirmedChange={onSavedConfirmedChange}
            onContinue={onConfirm}
            error={error}
          />
        </AuthScreen>
      );
  }
}

// --- add this device to an existing account --------------------------------

export type DeviceStep = "code" | "confirm" | "waiting" | "stopped";

// DeviceView renders from props alone. The optional interactive wiring is supplied by
// the client new-device flow (E04-S34) to drive the screen; when it is omitted the view
// renders as the static copy the render tests pin. The `code` step collects the email
// and the one-time code the approval request needs; `waiting` is shown while the person
// approves on a device they already use; `stopped` explains a refused or expired request
// and offers to start again.
export interface DeviceViewProps {
  busy?: boolean;
  step: DeviceStep;
  email?: string;
  code?: string;
  error?: string;
  // A plain status line under the form (e.g. the code was emailed).
  notice?: string;
  onEmailChange?: (value: string) => void;
  onCodeChange?: (value: string) => void;
  // "Email me a code": send the one-time code to the email entered above.
  onSendCode?: () => void;
  onSubmit?: () => void;
  onStartAgain?: () => void;
  // Where to go after signing in (a validated relative path), carried on the links
  // to the other auth screens.
  returnTo?: string;
}

export function DeviceView({
  step,
  busy,
  email,
  code,
  error,
  notice,
  onEmailChange,
  onCodeChange,
  onSendCode,
  onSubmit,
  onStartAgain,
  returnTo,
}: DeviceViewProps) {
  switch (step) {
    case "code":
      return (
        <AuthScreen
          title="Add this device"
          lead="Enter your email and we'll email you a code. Then enter the code to add this device to your account."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmit?.();
            }}
          >
            <Field
              disabled={busy}
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
            />
            <Button type="button" variant="secondary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onSendCode?.(); }}>
              {busy ? "Please wait…" : "Email me a code"}
            </Button>
            {notice ? (
              <p role="status" className="text-sm text-fg-muted">
                {notice}
              </p>
            ) : null}
            <Field
              disabled={busy}
              label="Your code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Continue"}
            </Button>
          </form>
          <AuthLinks links={DEVICE_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
    case "confirm":
      return (
        <AuthScreen
          title="Confirm it's you"
          lead="To finish adding this device, confirm it's you with a passkey on a device you've already set up."
        >
          <Button type="button" variant="primary">
            Confirm with your passkey
          </Button>
        </AuthScreen>
      );
    case "waiting":
      return (
        <AuthScreen
          title="Waiting for approval"
          lead="We've asked a device you already use to approve adding this one. Approve it there and we'll finish setting up this device for you."
        >
          <p className="text-sm text-fg-muted">
            Keep this screen open while you approve on your other device.
          </p>
        </AuthScreen>
      );
    case "stopped":
      return (
        <AuthScreen title="We couldn't add this device">
          <p className="text-sm text-fg-muted">{error ?? "The approval didn't go through."}</p>
          <Button type="button" variant="primary" onClick={onStartAgain}>
            Start again
          </Button>
        </AuthScreen>
      );
  }
}

// --- reset (after losing every passkey AND the recovery code) ----------------

// The first three steps start a reset; the `setup-*` steps (review fix W5) set up a new
// passkey once a reset has finished: email, code, create a passkey, save the new recovery
// code.
export type ResetStep =
  | "identify"
  | "email-code"
  | "requested"
  | "setup-identify"
  | "setup-email-code"
  | "setup-passkey"
  | "setup-recovery";

// Before sign-in, no account preference is available: show the exact instant in
// explicitly labelled UTC, identically in the server and browser render.
function plainDate(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return formatAccountTime(date, "UTC");
}

// ResetView renders from props alone (review fix W3.3); the client reset flow supplies
// the wiring. The first screen says plainly what a reset does before anything starts: a
// 7-day wait, alerts everywhere, cancellable from a signed-in device, and the protected
// details erased. `completesAt` is when a requested reset finishes. `recoveryCode` is the
// NEW shown-once code of the set-up's last step.
export interface ResetViewProps {
  busy?: boolean;
  step: ResetStep;
  email?: string;
  emailCode?: string;
  completesAt?: string;
  recoveryCode?: string;
  savedConfirmed?: boolean;
  error?: string;
  onEmailChange?: (value: string) => void;
  onEmailCodeChange?: (value: string) => void;
  onSubmitIdentify?: () => void;
  onSubmitEmailCode?: () => void;
  onCreatePasskey?: () => void;
  onSavedConfirmedChange?: (value: boolean) => void;
  onConfirm?: () => void;
  returnTo?: string;
}

export function ResetView({
  step,
  busy,
  email,
  emailCode,
  completesAt,
  recoveryCode,
  savedConfirmed,
  error,
  onEmailChange,
  onEmailCodeChange,
  onSubmitIdentify,
  onSubmitEmailCode,
  onCreatePasskey,
  onSavedConfirmedChange,
  onConfirm,
  returnTo,
}: ResetViewProps) {
  switch (step) {
    case "identify":
      return (
        <AuthScreen
          title="Reset your account"
          lead="If you've lost every passkey and your recovery code, you can reset your account by email."
        >
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg-muted">
            <li>The reset takes 7 days. We'll let you know by email, text and notification.</li>
            <li>You can cancel it from any device you're still signed in on.</li>
            <li>
              It erases your saved cards and protected details, and disconnects your agents and services.
              Everything else is kept.
            </li>
          </ul>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitIdentify?.();
            }}
          >
            <Field
              disabled={busy}
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Send me a code"}
            </Button>
          </form>
          <AuthLinks links={RESET_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
    case "email-code":
      return (
        <AuthScreen
          title="Check your email"
          lead="If there's an account for that address, we've emailed it a code. Enter it to start the 7-day reset."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitEmailCode?.();
            }}
          >
            <Field
              disabled={busy}
              label="Your code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={emailCode}
              onChange={(event) => onEmailCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Start the reset"}
            </Button>
          </form>
        </AuthScreen>
      );
    case "requested": {
      const when = plainDate(completesAt);
      return (
        <AuthScreen title="Your reset has started">
          <p role="status" className="text-sm text-fg">
            {when ? `It will finish on ${when}.` : "It will finish in 7 days."} We've let you know on every
            channel you have with us. If you didn't ask for this, open Warthog on a device you're still
            signed in on and cancel it.
          </p>
          <AuthLinks links={[{ href: "/signin", label: "Back to sign in" }]} returnTo={returnTo} />
        </AuthScreen>
      );
    }
    case "setup-identify":
      return (
        <AuthScreen
          title="Set up a new passkey"
          lead="Once your reset has finished, enter your email and we'll send you a code. Then you can set up a new passkey."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitIdentify?.();
            }}
          >
            <Field
              disabled={busy}
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Send me a code"}
            </Button>
          </form>
          <AuthLinks links={RESET_SETUP_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
    case "setup-email-code":
      return (
        <AuthScreen
          title="Check your email"
          lead="If that account's reset has finished, we've emailed it a code. Enter it here."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitEmailCode?.();
            }}
          >
            <Field
              disabled={busy}
              label="Your code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={emailCode}
              onChange={(event) => onEmailCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Continue"}
            </Button>
          </form>
        </AuthScreen>
      );
    case "setup-passkey":
      return (
        <AuthScreen
          title="Create a new passkey"
          lead="Create a passkey on this device to sign in from now on. Your old passkeys will stop working, and any other devices will be signed out."
        >
          <Button type="button" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onCreatePasskey?.(); }}>
            {busy ? "Please wait…" : "Create a passkey"}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </AuthScreen>
      );
    case "setup-recovery":
      return (
        <AuthScreen
          title="Save your new recovery code"
          lead="Here's your new recovery code. Write it down and keep it safe, and we'll only show it once."
        >
          <SaveRecoveryCode
            working={busy}
            code={recoveryCode}
            savedConfirmed={savedConfirmed}
            onSavedConfirmedChange={onSavedConfirmedChange}
            onContinue={onConfirm}
            error={error}
          />
        </AuthScreen>
      );
  }
}
