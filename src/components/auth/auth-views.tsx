import * as React from "react";
import { ChevronDown, Fingerprint, KeyRound, LifeBuoy, Mail, MonitorSmartphone, RotateCcw, ShieldCheck, UserRoundCheck } from "lucide-react";

import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Notice, type NoticeTone } from "../ui/notice";
import { AuthScreen } from "./auth-screen";
import { RecoveryCodeDisplay } from "./recovery-code";
import { withReturnPath } from "../../server/auth/return-path";

// Auth page views (task E04-S12) — the Signup, Signin, Recover, Reset and Device screens
// as plain, step-driven PRESENTATION components. They render from props alone: no
// session, no browser, no protocol machinery — so the thin entry files
// (signup / signin / device / recover page.tsx) stay thin and compose these, and a
// render test can pin the exact plain copy a person reads at each step.
//
// Everything on these primary screens is said in plain Australian English — the
// only "technical" words are the brief's own plain vocabulary ("passkey",
// "recovery code", "authenticator", "code"); no protocol/security jargon reaches
// them (brief design_ux.copy; constitution INV-22; design §5). Colour, spacing and
// radius come from the design tokens via the Button/Field/Notice primitives.
//
// UI/UX pass (12 Nov 2026): every form posts (method="post") so a submit before
// hydration can never put an email or code in the address bar (public-03); fields stay
// focusable but read-only while a step is working (a11y-01); form-level outcomes sit in
// one Notice slot above the primary action (public-13); every screen offers its other
// routes the same way (public-12); code steps show the address with a way to change it
// (public-04). The views call no hooks themselves, so tests can call them as functions.

// --- shared layout ---------------------------------------------------------

// The other ways in, as plain links. Each carries the return path along (when there is
// one), so moving between auth screens never loses where the person was going.
interface AuthLink {
  readonly href: string;
  readonly label: string;
}

const LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function AuthLinks({ links, returnTo }: { links: readonly AuthLink[]; returnTo?: string }) {
  return (
    <nav aria-label="Account navigation" className="wh-auth-links">
      <ul>
        {links.map((link) => (
          <li key={link.href + link.label}>
            <a href={withReturnPath(link.href, returnTo)} className={LINK_CLASS}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// The single most relevant alternative as a sentence, the rest under one native
// disclosure, below a divider — the same block on every screen.
interface AuthRoute extends AuthLink {
  readonly lead?: string;
}

function AuthAlternatives({ primary, more, moreLabel = "Other ways in", returnTo }: {
  primary?: AuthRoute;
  more?: readonly AuthLink[];
  moreLabel?: string;
  returnTo?: string;
}) {
  return (
    <div className="wh-auth-alternatives">
      {primary ? (
        <p>
          {primary.lead ? <>{primary.lead}{" "}</> : null}
          <a href={withReturnPath(primary.href, returnTo)}>{primary.label}</a>
        </p>
      ) : null}
      {more && more.length ? (
        <details className="wh-auth-help">
          <summary>{moreLabel} <ChevronDown size={16} aria-hidden="true" /></summary>
          <AuthLinks links={more} returnTo={returnTo} />
        </details>
      ) : null}
    </div>
  );
}

// One slot for a form-level outcome (a cancelled passkey, a send that didn't go through,
// a throttled request): words, icon and colour, never a field error. `id` lets the form
// point at it with aria-describedby.
function FormNotice({ id, message, tone = "error", children }: {
  id?: string;
  message?: string;
  tone?: NoticeTone;
  children?: React.ReactNode;
}) {
  if (!message) return null;
  return (
    <div id={id} className="wh-auth-notice">
      <Notice tone={tone}>{message}</Notice>
      {children}
    </div>
  );
}

// The address a code was sent to, with a way back to change it. "Use a different email"
// is a client-side step back; it sends nothing.
function EmailIdentity({ email, onChange, working }: { email?: string; onChange?: () => void; working?: boolean }) {
  if (!email) return null;
  return (
    <div className="wh-auth-identity">
      <span><span>Email</span>{email}</span>
      {onChange ? (
        <button type="button" className="wh-auth-text-button" aria-disabled={working || undefined} onClick={() => { if (!working) onChange(); }}>
          Use a different email
        </button>
      ) : null}
    </div>
  );
}

// Fields stay focusable while a step is working: read-only and marked disabled for
// assistive technology, never natively disabled (which would drop focus to the page).
function pending(working: boolean | undefined) {
  return working ? { readOnly: true, "aria-disabled": true as const } : {};
}

const CODE_TIMING =
  "Codes can take a minute to arrive. We send at most one a minute, so if you asked moments ago, use the code you already have.";

const SIGNIN_MORE: readonly AuthLink[] = [
  // Follow-up S3: approved from Settings › Security › Sign-in requests on a signed-in device.
  { href: "/device", label: "Signed in somewhere else? Approve from another device" },
  { href: "/recover", label: "Lost your passkey? Recover your account" },
  { href: "/reset", label: "Lost everything? Reset your account" },
  { href: "/reset/setup", label: "Reset finished? Set up a new passkey" },
];

const CREATE_ACCOUNT: AuthRoute = { lead: "New to Warthog?", href: "/signup", label: "Create an account" };
const SIGN_IN: AuthRoute = { lead: "Already have an account?", href: "/signin", label: "Sign in" };
const FOUND_PASSKEY: AuthRoute = { lead: "Found your passkey?", href: "/signin", label: "Sign in" };

// The read-only, shown-once recovery code, a tick to confirm it is saved, and the
// gated Continue. The code is rendered as plain text (never prefilled into an editable
// input) so it is never carried as a form value — the person reads, copies or writes it
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
      <RecoveryCodeDisplay code={code} />
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
      <FormNotice message={error} />
      <Button type="button" variant="primary" disabled={!savedConfirmed} aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50" onClick={() => { if (!working && savedConfirmed) onContinue?.(); }}>
        Continue
      </Button>
    </div>
  );
}

// --- sign-up ---------------------------------------------------------------

export type SignupStep = "details" | "code" | "passkey" | "authenticator" | "recovery" | "exists";

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
  // The details-step error came from a throttled send: a code went to this address
  // moments ago, so the error is about the form, not the email field.
  codeThrottled?: boolean;
  // A plain, non-error status line (e.g. a new code was sent).
  notice?: string;
  savedConfirmed?: boolean;
  onNameChange?: (value: string) => void;
  onEmailChange?: (value: string) => void;
  onCodeChange?: (value: string) => void;
  onSavedConfirmedChange?: (value: boolean) => void;
  onSubmit?: () => void;
  onCreatePasskey?: () => void;
  onConfirm?: () => void;
  // Back to the details step to change the address (client-side only).
  onChangeEmail?: () => void;
  // Ask for a new code to the same address (the same send-code request).
  onResendCode?: () => void;
  // Go to the code step with a code the person already has (after a throttled send).
  onUseExistingCode?: () => void;
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
  codeThrottled = false,
  notice,
  savedConfirmed,
  onNameChange,
  onEmailChange,
  onCodeChange,
  onSavedConfirmedChange,
  onSubmit,
  onCreatePasskey,
  onConfirm,
  onChangeEmail,
  onResendCode,
  onUseExistingCode,
  returnTo,
}: SignupViewProps) {
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!working) onSubmit?.();
  };
  const fromAgent = returnTo?.startsWith("/oauth/") ?? false;
  switch (step) {
    case "details":
      return (
        <AuthScreen
          title="Create your account"
          lead={fromAgent
            ? "Create your account to finish connecting your agent. We’ll email a code to confirm your address, and you’ll review the agent’s access next."
            : "Start your personal agent workspace. We’ll email a code to confirm your address."}
          stage={1} icon={ShieldCheck} error={codeThrottled ? undefined : error}
        >
          <form method="post" className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Field
              label="Your name"
              name="name"
              type="text"
              required {...pending(working)}
              autoComplete="name"
              value={name ?? ""}
              onChange={(event) => onNameChange?.(event.target.value)}
            />
            <Field
              label="Email address"
              name="email"
              type="email"
              required {...pending(working)}
              autoComplete="email"
              value={email ?? ""}
              onChange={(event) => onEmailChange?.(event.target.value)}
              error={codeThrottled ? undefined : error}
            />
            <FormNotice message={codeThrottled ? error : undefined} tone="warning">
              {onUseExistingCode ? (
                <Button type="button" variant="secondary" className="self-start" onClick={() => { if (!working) onUseExistingCode(); }}>
                  Enter the code I already have
                </Button>
              ) : null}
            </FormNotice>
            <Button type="submit" variant="primary" aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
              Continue
            </Button>
          </form>
          <AuthAlternatives primary={SIGN_IN} returnTo={returnTo} />
        </AuthScreen>
      );
    case "code":
      return (
        <AuthScreen
          title="Check your email"
          lead={`Enter the six-digit code we emailed you to confirm it’s your address. ${CODE_TIMING}`}
          stage={2} icon={Mail} error={error}
        >
          <form method="post" className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <EmailIdentity email={email} onChange={onChangeEmail} working={working} />
            <Field
              label="Your code"
              name="code"
              type="text"
              required {...pending(working)}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
              error={error}
            />
            <FormNotice message={notice} tone="info" />
            <Button type="submit" variant="primary" aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
              Continue
            </Button>
          </form>
          {onResendCode ? (
            <Button type="button" variant="secondary" aria-disabled={working || undefined} className="aria-disabled:opacity-50" onClick={() => { if (!working) onResendCode(); }}>
              Send a new code
            </Button>
          ) : null}
          <AuthAlternatives primary={SIGN_IN} returnTo={returnTo} />
        </AuthScreen>
      );
    case "passkey":
      return (
        <AuthScreen
          title="Set up a passkey"
          lead="A passkey lets you sign in with your fingerprint, face or device PIN — there's no password to remember."
          stage={3} error={error}
        >
          <FormNotice message={error} />
          <Button type="button" variant="primary" onClick={() => { if (!working) onCreatePasskey?.(); }} aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
            Create a passkey
          </Button>
          <Button type="button" variant="secondary" onClick={() => { if (!working) onUseAuthenticatorApp?.(); }} aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">
            Use an authenticator app
          </Button>
        </AuthScreen>
      );
    case "authenticator":
      return (
        <AuthScreen title="Set up your authenticator app" lead="Scan this code with your authenticator app, or enter the setup key manually. Then enter the six-digit code it shows." stage={3} icon={ShieldCheck} error={error}>
          {authenticatorQr ? <img src={authenticatorQr} alt="Authenticator app setup code" width={256} height={256} className="h-auto max-w-full self-center rounded-card bg-surface-muted p-2" /> : null}
          <p className="break-all rounded-card bg-surface-muted p-3 font-mono text-sm">{authenticatorSecret}</p>
          <form method="post" className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Field label="Authenticator app code" name="totp" type="text" inputMode="numeric"
              autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} {...pending(working)}
              value={code ?? ""} onChange={(event) => onCodeChange?.(event.target.value)} error={error} />
            <Button type="submit" variant="primary" aria-disabled={working} aria-busy={working} className="aria-disabled:opacity-50">Confirm authenticator app</Button>
          </form>
          <AuthAlternatives primary={{ lead: "Changed your mind?", href: "/signup", label: "Start sign-up again" }} returnTo={returnTo} />
        </AuthScreen>
      );
    case "recovery":
      return (
        <AuthScreen
          title="Save your recovery code"
          lead="Write this code down or copy it somewhere safe. It's the way back in if you lose your sign-in methods, and we'll only show it once."
          stage={4} icon={KeyRound}
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
    case "exists":
      // Confirm found the address already has an account (public-02). Nothing from this
      // sign-up was saved; say so, and offer the two ways in.
      return (
        <AuthScreen
          title="You already have an account"
          lead={email ? `There’s already a Warthog account for ${email}, so we didn’t create a new one.` : "There’s already a Warthog account for this email address, so we didn’t create a new one."}
          icon={UserRoundCheck}
        >
          <Notice tone="info">
            {error ?? "Sign in instead, or recover your account if you’ve lost your passkey."}
          </Notice>
          <a href={withReturnPath("/signin", returnTo)} className="inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2">
            Sign in
          </a>
          <a href={withReturnPath("/recover", returnTo)} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2">
            Recover your account
          </a>
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
  // A plain, non-error status line (e.g. a new email code was sent).
  notice?: string;
  busy?: boolean;
  onEmailChange?: (value: string) => void;
  onCodeChange?: (value: string) => void;
  onPasskey?: () => void;
  onUseAuthenticatorApp?: () => void;
  onSubmitCode?: () => void;
  // Ask for a new email code (the same send-email-code request).
  onResendCode?: () => void;
  // Where to go after signing in (a validated relative path), carried on the links
  // to the other auth screens.
  returnTo?: string;
}

export function SigninView({
  step,
  email,
  code,
  error,
  notice,
  busy,
  onEmailChange,
  onCodeChange,
  onPasskey,
  onUseAuthenticatorApp,
  onSubmitCode,
  onResendCode,
  returnTo,
}: SigninViewProps) {
  // SigninView is the page's single primary screen, like AuthScreen's heading.
  const formErrorId = "signin-error";
  const fromAgent = returnTo?.startsWith("/oauth/") ?? false;
  switch (step) {
    case "passkey":
      return (
        <AuthScreen
          title="Welcome back"
          lead={fromAgent
            ? "Sign in to finish connecting your agent. You’ll review its access next."
            : "Sign in to your personal agent workspace with your fingerprint, face or device PIN."}
          error={error}
        >
          <form
            method="post"
            className="flex flex-col gap-4"
            aria-describedby={error ? formErrorId : undefined}
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
              required
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              {...pending(busy)}
            />
            <FormNotice id={formErrorId} message={error} />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              <Fingerprint size={18} aria-hidden="true" /> {busy ? "Signing in…" : "Sign in with your passkey"}
            </Button>
          </form>
          <Button type="button" variant="secondary" aria-disabled={busy || undefined} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onUseAuthenticatorApp?.(); }}>
            Use my authenticator app instead
          </Button>
          <AuthAlternatives primary={CREATE_ACCOUNT} more={SIGNIN_MORE} moreLabel="Other ways to sign in" returnTo={returnTo} />
        </AuthScreen>
      );
    case "email":
    case "email-code":
    case "code":
      return (
        <AuthScreen
          title={step === "email" ? "Check your email first" : step === "email-code" ? "Enter your email code" : "Sign in with a code"}
          lead={step === "email" ? "If you set up an authenticator app, we’ll email you a code first, then ask for the code from your app."
            : step === "email-code" ? `Enter the six-digit code from your latest Warthog email. ${CODE_TIMING}`
            : "Your email is verified. Enter the code from your authenticator app."}
          icon={step === "code" ? ShieldCheck : Mail}
          error={error}
        >
          <form
            method="post"
            className="flex flex-col gap-4"
            aria-describedby={step === "email" && error ? formErrorId : undefined}
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
              required
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
              {...pending(busy)}
            /> : <EmailIdentity email={email} onChange={onUseAuthenticatorApp} working={busy} />}
            {step === "email" ? <FormNotice id={formErrorId} message={error} /> : null}
            {step !== "email" ? <Field
              label={step === "email-code" ? "Email code" : "Authenticator code"}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(event) => onCodeChange?.(event.target.value)}
              {...pending(busy)}
              error={error}
            /> : null}
            {step !== "email" ? <FormNotice message={notice} tone="info" /> : null}
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : step === "email" ? "Send email code" : step === "email-code" ? "Verify email" : "Sign in"}
            </Button>
          </form>
          {step === "email-code" && onResendCode ? (
            <Button type="button" variant="secondary" aria-disabled={busy || undefined} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onResendCode(); }}>
              Send a new code
            </Button>
          ) : null}
          <AuthAlternatives
            primary={step === "code"
              ? { lead: "Didn’t set up an authenticator app?", href: "/signin", label: "Sign in with your passkey" }
              : { lead: "Have a passkey?", href: "/signin", label: "Use a passkey" }}
            more={[...SIGNIN_MORE, { href: "/signup", label: "New to Warthog? Create an account" }]}
            moreLabel="Other ways to sign in"
            returnTo={returnTo}
          />
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
  // Back to the first step to change the address (client-side only).
  onChangeEmail?: () => void;
  // Where to go after signing in (a validated relative path), carried on the links
  // to the other auth screens.
  returnTo?: string;
}

const RECOVER_MORE: readonly AuthLink[] = [{ href: "/reset", label: "Lost your recovery code too? Reset your account" }];

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
  onChangeEmail,
  returnTo,
}: RecoverViewProps) {
  switch (step) {
    case "identify":
      return (
        <AuthScreen
          title="Recover your account"
          lead="First, let's check it's you. Enter your email and we'll send you a code."
          icon={LifeBuoy} error={error}
        >
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitIdentify?.();
            }}
          >
            <Field
              {...pending(busy)}
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
            />
            <FormNotice message={error} />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Send me a code"}
            </Button>
          </form>
          <AuthAlternatives primary={FOUND_PASSKEY} more={RECOVER_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "email-code":
      return (
        <AuthScreen
          title="Check your email"
          lead={`If there's an account for that address, enter the six-digit code from our email. ${CODE_TIMING}`}
          icon={Mail} error={error}
        >
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitEmailCode?.();
            }}
          >
            <EmailIdentity email={email} onChange={onChangeEmail} working={busy} />
            <Field
              {...pending(busy)}
              label="Your code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={emailCode}
              onChange={(event) => onEmailCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Continue"}
            </Button>
          </form>
          <AuthAlternatives primary={FOUND_PASSKEY} more={RECOVER_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "recovery-code":
      return (
        <AuthScreen
          title="Enter your recovery code"
          lead="Enter the recovery code you saved when you first set up your account."
          icon={KeyRound} error={error}
        >
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmitRecoveryCode?.();
            }}
          >
            <Field
              {...pending(busy)}
              label="Recovery code"
              name="recoveryCode"
              type="text"
              autoComplete="off"
              required
              value={recoveryCodeValue}
              onChange={(event) => onRecoveryCodeChange?.(event.target.value)}
              error={error}
            />
            <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
              {busy ? "Please wait…" : "Continue"}
            </Button>
          </form>
          <AuthAlternatives
            primary={{ lead: "Lost your recovery code too?", href: "/reset", label: "Reset your account" }}
            more={[{ href: "/signin", label: "Found your passkey? Sign in" }]}
            returnTo={returnTo}
          />
        </AuthScreen>
      );
    case "passkey":
      return (
        <AuthScreen
          title="Set up a new passkey"
          lead="Now create a new passkey so you can sign in on this device from now on. Once it's saved, your old passkeys and authenticator app stop working and every other device is signed out."
          error={error}
        >
          <FormNotice message={error} />
          <Button type="button" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onCreatePasskey?.(); }}>
            {busy ? "Please wait…" : "Create a passkey"}
          </Button>
        </AuthScreen>
      );
    case "new-recovery":
      return (
        <AuthScreen
          title="Save your new recovery code"
          lead="Your old passkeys, authenticator app and recovery code no longer work, and every other device was signed out. Here's your new recovery code. Write it down or copy it somewhere safe, and we'll only show it once."
          icon={KeyRound}
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

// Where the request is approved (follow-up S3): a signed-in device's Settings › Security ›
// Sign-in requests screen lists it. Said on both steps, so nobody waits without knowing where
// to look.
const DEVICE_WHERE =
  "You approve it on a device where you're already signed in to Warthog: open Settings › Security › Sign-in requests there.";

const DEVICE_ROUTES: AuthRoute = { lead: "Have a passkey on this device?", href: "/signin", label: "Sign in" };
const DEVICE_MORE: readonly AuthLink[] = [{ href: "/recover", label: "Lost your passkey? Recover your account" }];

// DeviceView renders from props alone. The optional interactive wiring is supplied by
// the client new-device flow (E04-S34) to drive the screen; when it is omitted the view
// renders as the static copy the render tests pin. The `code` step collects the email
// and the one-time code the approval request needs; `waiting` is shown after the request
// is made; `stopped` explains a refused or expired request and offers to start again.
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
  // "Send me a code": send the one-time code to the email entered above.
  onSendCode?: () => void;
  onSubmit?: () => void;
  onStartAgain?: () => void;
  // Where to go after signing in (a validated relative path), carried on the links
  // to the other auth screens.
  returnTo?: string;
  // While waiting: the label the approving device lists this request under, and when the
  // request expires.
  deviceLabel?: string;
  expires?: string;
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
  deviceLabel,
  expires,
}: DeviceViewProps) {
  switch (step) {
    case "code":
      return (
        <AuthScreen
          title="Add this device"
          lead="Enter your email and we'll send you a code. Enter it here, then approve this device from one where you're already signed in."
          icon={MonitorSmartphone} error={error}
        >
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSubmit?.();
            }}
          >
            <Notice tone="info" announce={false}>{DEVICE_WHERE}</Notice>
            <Field
              {...pending(busy)}
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => onEmailChange?.(event.target.value)}
            />
            <Button type="button" variant="secondary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onSendCode?.(); }}>
              {busy ? "Please wait…" : "Send me a code"}
            </Button>
            <FormNotice message={notice} tone="info" />
            <Field
              {...pending(busy)}
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
          <AuthAlternatives primary={DEVICE_ROUTES} more={DEVICE_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "confirm":
      return (
        <AuthScreen
          title="Confirm it's you"
          lead="To finish adding this device, confirm it's you with a passkey on a device you've already set up."
          icon={MonitorSmartphone}
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
          lead={`Your request is waiting${expires ? ` until ${expires}` : " for 10 minutes"}. This page carries on by itself once it's approved.`}
          icon={MonitorSmartphone}
        >
          <Notice tone="info" announce={false}>
            <p>{DEVICE_WHERE}</p>
            {deviceLabel ? <p className="mt-2">{`Look for the request from “${deviceLabel}”. Only approve it if it's this device.`}</p> : (
              <p className="mt-2">Only approve it if it&apos;s this device.</p>
            )}
          </Notice>
          <p role="status" className="text-sm text-fg-muted">Checking for approval…</p>
          <Button type="button" variant="secondary" onClick={onStartAgain}>
            Start again
          </Button>
          <AuthAlternatives primary={DEVICE_ROUTES} more={DEVICE_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "stopped":
      return (
        <AuthScreen title="We couldn't add this device" icon={MonitorSmartphone}>
          <Notice tone="error">{error ?? "The approval didn't go through."}</Notice>
          <Button type="button" variant="primary" onClick={onStartAgain}>
            Start again
          </Button>
          <AuthAlternatives primary={DEVICE_ROUTES} more={DEVICE_MORE} returnTo={returnTo} />
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

// The reset's end, in plain words in the browser's own time zone (this step only ever
// renders in the browser, after the request, so the server never renders a different one).
function plainDate(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

const RESET_PRIMARY: AuthRoute = { lead: "Still have your recovery code?", href: "/recover", label: "Recover your account" };
const RESET_MORE: readonly AuthLink[] = [
  { href: "/signin", label: "Found your passkey? Sign in" },
  { href: "/reset/setup", label: "Reset finished? Set up a new passkey" },
];
const SETUP_PRIMARY: AuthRoute = { lead: "Haven't reset yet?", href: "/reset", label: "Reset your account" };
const SETUP_MORE: readonly AuthLink[] = [{ href: "/signin", label: "Back to sign in" }];

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
  // Back to the first step to change the address (client-side only).
  onChangeEmail?: () => void;
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
  onChangeEmail,
  returnTo,
}: ResetViewProps) {
  const identifyForm = (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmitIdentify?.();
      }}
    >
      <Field
        {...pending(busy)}
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => onEmailChange?.(event.target.value)}
      />
      <FormNotice message={error} />
      <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
        {busy ? "Please wait…" : "Send me a code"}
      </Button>
    </form>
  );
  const codeForm = (submitLabel: string) => (
    <form
      method="post"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmitEmailCode?.();
      }}
    >
      <EmailIdentity email={email} onChange={onChangeEmail} working={busy} />
      <Field
        {...pending(busy)}
        label="Your code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        value={emailCode}
        onChange={(event) => onEmailCodeChange?.(event.target.value)}
        error={error}
      />
      <Button type="submit" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50">
        {busy ? "Please wait…" : submitLabel}
      </Button>
    </form>
  );
  switch (step) {
    case "identify":
      return (
        <AuthScreen
          title="Reset your account"
          lead="If you've lost every passkey and your recovery code, you can reset your account by email."
          icon={RotateCcw} error={error}
        >
          <Notice tone="warning" announce={false}>
            <p className="font-medium">Before you reset</p>
            <ul className="wh-auth-steps mt-2 text-fg-muted">
              <li>The reset takes 7 days. We'll let you know by email, text and notification.</li>
              <li>When it finishes, you have 7 days to set up a new passkey.</li>
              <li>You can cancel it from any device you're still signed in on.</li>
              <li>
                It erases your saved cards and protected details, and disconnects your agents and services.
                Everything else is kept.
              </li>
            </ul>
          </Notice>
          {identifyForm}
          <AuthAlternatives primary={RESET_PRIMARY} more={RESET_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "email-code":
      return (
        <AuthScreen
          title="Check your email"
          lead={`If there's an account for that address, enter the code from our email to start the 7-day reset. ${CODE_TIMING}`}
          icon={Mail} error={error}
        >
          {codeForm("Start the reset")}
          <AuthAlternatives primary={RESET_PRIMARY} more={RESET_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "requested": {
      const when = plainDate(completesAt);
      return (
        <AuthScreen title="Your reset has started" icon={RotateCcw}>
          <Notice tone="success">
            {when ? `It will finish on ${when}.` : "It will finish in 7 days."} We've let you know on every
            channel you have with us. When it finishes, you'll have 7 days to set up a new passkey. If you
            didn't ask for this, open Warthog on a device you're still signed in on and cancel it.
          </Notice>
          <AuthLinks
            links={[
              { href: "/reset/setup", label: "When it finishes, set up a new passkey" },
              { href: "/signin", label: "Back to sign in" },
            ]}
            returnTo={returnTo}
          />
        </AuthScreen>
      );
    }
    case "setup-identify":
      return (
        <AuthScreen
          title="Set up a new passkey"
          lead="Once your reset has finished, enter your email and we'll send you a code. Then you can set up a new passkey."
          error={error}
        >
          {identifyForm}
          <AuthAlternatives primary={SETUP_PRIMARY} more={SETUP_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "setup-email-code":
      return (
        <AuthScreen
          title="Check your email"
          lead={`If that account's reset has finished, enter the code from our email. ${CODE_TIMING}`}
          icon={Mail} error={error}
        >
          {codeForm("Continue")}
          <AuthAlternatives primary={SETUP_PRIMARY} more={SETUP_MORE} returnTo={returnTo} />
        </AuthScreen>
      );
    case "setup-passkey":
      return (
        <AuthScreen
          title="Create a new passkey"
          lead="Create a passkey on this device to sign in from now on. Your old passkeys will stop working, and any other devices will be signed out."
          error={error}
        >
          <FormNotice message={error} />
          <Button type="button" variant="primary" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => { if (!busy) onCreatePasskey?.(); }}>
            {busy ? "Please wait…" : "Create a passkey"}
          </Button>
        </AuthScreen>
      );
    case "setup-recovery":
      return (
        <AuthScreen
          title="Save your new recovery code"
          lead="Here's your new recovery code. Write it down or copy it somewhere safe, and we'll only show it once."
          icon={KeyRound}
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
