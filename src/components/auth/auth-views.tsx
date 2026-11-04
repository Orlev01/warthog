import * as React from "react";

import { Button } from "../ui/button";
import { Field } from "../ui/field";

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

// One screen: a page heading, an optional plain lead sentence, then the step body.
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
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {lead ? <p className="text-sm text-fg-muted">{lead}</p> : null}
      {children}
    </div>
  );
}

// The read-only, shown-once recovery code plus its "I've saved it" confirmation.
// The code is rendered as plain text (never prefilled into an editable input) so it
// is never carried as a form value — the person reads it and writes it down.
function SaveRecoveryCode({ code }: { code?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-fg">Your recovery code</span>
        <p className="rounded-card border border-line bg-surface-muted px-3 py-3 text-center font-mono text-lg tracking-widest text-fg">
          {code}
        </p>
      </div>
      <Button type="button" variant="primary">
        I&apos;ve saved it
      </Button>
    </div>
  );
}

// --- sign-up ---------------------------------------------------------------

export type SignupStep = "details" | "code" | "passkey" | "recovery";

export function SignupView({ step, recoveryCode }: { step: SignupStep; recoveryCode?: string }) {
  switch (step) {
    case "details":
      return (
        <AuthScreen title="Create your account" lead="Tell us a little about you to get started.">
          <form className="flex flex-col gap-4">
            <Field label="Your name" name="name" type="text" autoComplete="name" />
            <Field label="Email address" name="email" type="email" autoComplete="email" />
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </form>
        </AuthScreen>
      );
    case "code":
      return (
        <AuthScreen
          title="Check your email"
          lead="Enter the code we emailed you to confirm it's your address."
        >
          <form className="flex flex-col gap-4">
            <Field label="Your code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" />
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
          <Button type="button" variant="primary">
            Create a passkey
          </Button>
        </AuthScreen>
      );
    case "recovery":
      return (
        <AuthScreen
          title="Save your recovery code"
          lead="Write this code down and keep it somewhere safe. It's the only way back in if you ever lose your passkey, and we'll only show it once."
        >
          <SaveRecoveryCode code={recoveryCode} />
        </AuthScreen>
      );
  }
}

// --- sign-in ---------------------------------------------------------------

export type SigninStep = "passkey" | "code";

export function SigninView({ step }: { step: SigninStep }) {
  switch (step) {
    case "passkey":
      return (
        <AuthScreen
          title="Welcome back"
          lead="Use your passkey to sign in — your fingerprint, face or device PIN."
        >
          <Button type="button" variant="primary">
            Sign in with your passkey
          </Button>
        </AuthScreen>
      );
    case "code":
      return (
        <AuthScreen
          title="Sign in with a code"
          lead="Enter your email and the code from your authenticator app."
        >
          <form className="flex flex-col gap-4">
            <Field label="Email address" name="email" type="email" autoComplete="email" />
            <Field
              label="Authenticator code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
            <Button type="submit" variant="primary">
              Sign in
            </Button>
          </form>
        </AuthScreen>
      );
  }
}

// --- recover (after losing every passkey) ----------------------------------

export type RecoverStep = "identify" | "recovery-code" | "passkey" | "new-recovery";

export function RecoverView({ step, recoveryCode }: { step: RecoverStep; recoveryCode?: string }) {
  switch (step) {
    case "identify":
      return (
        <AuthScreen
          title="Recover your account"
          lead="First, let's check it's you. Enter your email and the code we'll send you."
        >
          <form className="flex flex-col gap-4">
            <Field label="Email address" name="email" type="email" autoComplete="email" />
            <Field label="Your code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" />
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
          <form className="flex flex-col gap-4">
            <Field label="Recovery code" name="recoveryCode" type="text" autoComplete="off" />
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
          <Button type="button" variant="primary">
            Create a passkey
          </Button>
        </AuthScreen>
      );
    case "new-recovery":
      return (
        <AuthScreen
          title="Save your new recovery code"
          lead="Here's your new recovery code — your old one no longer works. Write it down and keep it safe, and we'll only show it once."
        >
          <SaveRecoveryCode code={recoveryCode} />
        </AuthScreen>
      );
  }
}

// --- add this device to an existing account --------------------------------

export type DeviceStep = "code" | "confirm";

export function DeviceView({ step }: { step: DeviceStep }) {
  switch (step) {
    case "code":
      return (
        <AuthScreen
          title="Add this device"
          lead="Enter the code we emailed you to add this device to your account."
        >
          <form className="flex flex-col gap-4">
            <Field label="Your code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" />
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </form>
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
  }
}
