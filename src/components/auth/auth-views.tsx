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
              className="rounded-card text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
];

const SIGNUP_LINKS: readonly AuthLink[] = [
  { href: "/signin", label: "Already have an account? Sign in" },
];

const RECOVER_LINKS: readonly AuthLink[] = [
  { href: "/signin", label: "Found your passkey? Sign in" },
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
  onSavedConfirmedChange,
  onContinue,
  error,
}: {
  code?: string;
  savedConfirmed?: boolean;
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
      <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm text-fg">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-line accent-accent"
          checked={savedConfirmed}
          onChange={(event) => onSavedConfirmedChange?.(event.target.checked)}
        />
        <span>I&apos;ve saved it</span>
      </label>
      <Button type="button" variant="primary" disabled={!savedConfirmed} onClick={onContinue}>
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

export type SignupStep = "details" | "code" | "passkey" | "recovery";

// SignupView renders from props alone. The optional interactive wiring is supplied by
// the client sign-up flow (E04-S24) to drive the screen; when it is omitted the view
// renders as the static copy the render tests pin.
export interface SignupViewProps {
  step: SignupStep;
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
    onSubmit?.();
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
              autoComplete="name"
              value={name ?? ""}
              onChange={(event) => onNameChange?.(event.target.value)}
            />
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email ?? ""}
              onChange={(event) => onEmailChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary">
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
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary">
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
          <Button type="button" variant="primary" onClick={onCreatePasskey}>
            Create a passkey
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </AuthScreen>
      );
    case "recovery":
      return (
        <AuthScreen
          title="Save your recovery code"
          lead="Write this code down and keep it somewhere safe. It's the only way back in if you ever lose your passkey, and we'll only show it once."
        >
          <SaveRecoveryCode
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

// --- sign-in ---------------------------------------------------------------

export type SigninStep = "passkey" | "code";

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
              onPasskey?.();
            }}
          >
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
            />
            <Button type="submit" variant="primary">
              Sign in with your passkey
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="button" variant="secondary" onClick={onUseAuthenticatorApp}>
            Use my authenticator app instead
          </Button>
          <AuthLinks links={SIGNIN_LINKS} returnTo={returnTo} />
        </AuthScreen>
      );
    case "code":
      return (
        <AuthScreen
          title="Sign in with a code"
          lead="Enter your email and the code from your authenticator app."
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitCode?.();
            }}
          >
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
            />
            <Field
              label="Authenticator code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
            />
            <Button type="submit" variant="primary">
              Sign in
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
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
              onSubmitIdentify?.();
            }}
          >
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary">
              Send me a code
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
              onSubmitEmailCode?.();
            }}
          >
            <Field
              label="Your code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={emailCode}
              onChange={(event) => onEmailCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary">
              Continue
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
              onSubmitRecoveryCode?.();
            }}
          >
            <Field
              label="Recovery code"
              name="recoveryCode"
              type="text"
              autoComplete="off"
              value={recoveryCodeValue}
              onChange={(event) => onRecoveryCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary">
              Continue
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
          <Button type="button" variant="primary" onClick={onCreatePasskey}>
            Create a passkey
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
              onSubmit?.();
            }}
          >
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
            />
            <Button type="button" variant="secondary" onClick={onSendCode}>
              Email me a code
            </Button>
            {notice ? (
              <p role="status" className="text-sm text-fg-muted">
                {notice}
              </p>
            ) : null}
            <Field
              label="Your code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary">
              Continue
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
