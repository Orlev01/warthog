"use client";

import * as React from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { CheckCircle2, ShieldCheck } from "lucide-react";

import { Button } from "./button";
import { Field } from "./field";

// ConfirmItsYou — the shared inline step-up ("Confirm it's you") control (review fix G3;
// brief "Step-up check — a fresh passkey confirmation within the last 5 minutes"; design
// §5). Sensitive actions are refused once the last confirmation is older than five
// minutes; without this control every screen but Security left the person at a dead end
// ("re-authenticate, then try again", or "sign out and back in"). Any screen can mount it
// wherever a `step_up_required` refusal can come back.
//
// The repo's render-testable-AND-interactive split (FactorControls + createFactorControls):
//   • createConfirmItsYou(deps) — the framework-free controller:
//       POST /api/auth/step-up/begin   → keep { options }
//       → startAuthentication({ optionsJSON })  (the OS passkey prompt)
//       → POST /api/auth/step-up/finish { authenticationResponse }
//     The step-up endpoints take identity from the session cookie alone and check Origin
//     (the browser sets it); this client sends no identity of its own.
//   • ConfirmItsYou — a thin Client Component over it, with real browser defaults so the
//     control is live by construction.
// Outcomes are plain words (never a raw machine reason); a second tap while a ceremony
// is running is ignored. Colour comes from the design tokens (globals.css).

export type ConfirmItsYouStatus = "idle" | "working" | "confirmed" | "error";

export interface ConfirmItsYouState {
  readonly status: ConfirmItsYouStatus;
  readonly error?: string;
}

export interface ConfirmItsYouDeps {
  readonly fetch: typeof fetch;
  readonly startAuthentication: (opts: {
    optionsJSON: PublicKeyCredentialRequestOptionsJSON;
  }) => Promise<AuthenticationResponseJSON>;
  readonly onChange?: () => void;
  readonly onConfirmed?: () => void;
}

export interface ConfirmItsYouController {
  getState(): ConfirmItsYouState;
  // Resolves true once the session carries a fresh confirmation; false otherwise.
  confirm(): Promise<boolean>;
  confirmWithTotp(code: string): Promise<boolean>;
}

const STEP_UP_BASE = "/api/auth/step-up";

const FAILED_COPY = "We couldn't check it's you. Please try again.";
const CANCELLED_COPY = "Confirming it's you was cancelled. You can try again when you're ready.";

export function createConfirmItsYou(deps: ConfirmItsYouDeps): ConfirmItsYouController {
  let state: ConfirmItsYouState = { status: "idle" };

  function set(next: ConfirmItsYouState): void {
    state = next;
    deps.onChange?.();
  }

  // POST to a step-up endpoint; a thrown fetch (offline) is null, never a crash.
  async function post(step: "begin" | "finish" | "totp", body?: unknown): Promise<Response | null> {
    try {
      return await deps.fetch(`${STEP_UP_BASE}/${step}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return null;
    }
  }

  async function confirm(): Promise<boolean> {
    if (state.status === "working") return false;
    set({ status: "working" });

    const begin = await post("begin");
    if (!begin || !begin.ok) {
      set({ status: "error", error: FAILED_COPY });
      return false;
    }
    let options: PublicKeyCredentialRequestOptionsJSON | undefined;
    try {
      options = ((await begin.json()) as { options?: PublicKeyCredentialRequestOptionsJSON }).options;
    } catch {
      options = undefined;
    }
    if (options === undefined) {
      set({ status: "error", error: FAILED_COPY });
      return false;
    }

    // The OS passkey prompt; a dismissed / timed-out prompt rejects — nothing is posted.
    let authenticationResponse: AuthenticationResponseJSON;
    try {
      authenticationResponse = await deps.startAuthentication({ optionsJSON: options });
    } catch {
      set({ status: "error", error: CANCELLED_COPY });
      return false;
    }

    const finish = await post("finish", { authenticationResponse });
    if (!finish || !finish.ok) {
      set({ status: "error", error: FAILED_COPY });
      return false;
    }
    set({ status: "confirmed" });
    deps.onConfirmed?.();
    return true;
  }

  async function confirmWithTotp(code: string): Promise<boolean> {
    if (state.status === "working") return false;
    set({ status: "working" });
    const response = await post("totp", { totp: code });
    if (!response?.ok) {
      set({ status: "error", error: response?.status === 429
        ? "Too many attempts. Please wait before trying another authenticator code."
        : "We couldn't confirm that code. Use a fresh code from your authenticator app and try again." });
      return false;
    }
    set({ status: "confirmed" });
    deps.onConfirmed?.();
    return true;
  }

  return { getState: () => state, confirm, confirmWithTotp };
}

// ─── the client component ───────────────────────────────────────────────────────────

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export interface ConfirmItsYouProps {
  // Why a fresh confirmation is needed here, in plain words. Hidden once confirmed, so a
  // screen can pass its "nothing was changed, confirm first" refusal here and it clears
  // itself on success.
  explanation?: string;
  // Shown once confirmed (e.g. "Done — you can export now.").
  confirmedText?: string;
  onConfirmed?: () => void;
  // Which factors the member has, when the screen knows (the security loader reads both).
  // `false` hides that option; omitted keeps it, because an enrolled factor must be usable
  // wherever a confirmation is accepted (docs/adr/authenticator-step-up.md).
  passkey?: boolean;
  authenticator?: boolean;
  // Browser seams, overridable for tests.
  fetch?: typeof fetch;
  startAuthentication?: ConfirmItsYouDeps["startAuthentication"];
}

const DEFAULT_CONFIRMED = "Thanks — that's confirmed. You can carry on for the next five minutes.";

/** The default explanation, naming only the ways this member can confirm. */
export function confirmItsYouExplanation(options: { passkey: boolean; authenticator: boolean }): string {
  const lead = "We need to check it's really you before this goes ahead.";
  if (options.passkey && options.authenticator) return `${lead} Use your passkey or a code from your authenticator app.`;
  if (options.authenticator) return `${lead} Enter a code from your authenticator app.`;
  return `${lead} Use your passkey.`;
}

export function ConfirmItsYou(props: ConfirmItsYouProps): React.ReactElement {
  const [totpCode, setTotpCode] = React.useState("");
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const confirmedRef = React.useRef<HTMLDivElement>(null);
  const flowRef = React.useRef<ConfirmItsYouController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createConfirmItsYou({
      fetch: props.fetch ?? defaultFetch,
      startAuthentication: props.startAuthentication ?? startAuthentication,
      onChange: () => forceUpdate(),
      onConfirmed: props.onConfirmed,
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const working = state.status === "working";
  // A member with neither flag set false keeps both options; never hide both.
  const offerPasskey = props.passkey !== false || props.authenticator === false;
  const offerAuthenticator = props.authenticator !== false || props.passkey === false;

  // The controls disappear on success, so move focus (if it was here) to the outcome
  // instead of letting it fall back to the top of the page.
  const confirmed = state.status === "confirmed";
  React.useEffect(() => {
    if (!confirmed) return;
    const active = document.activeElement;
    if (active === document.body || (active && rootRef.current?.contains(active))) confirmedRef.current?.focus();
  }, [confirmed]);

  if (confirmed) {
    return (
      <div ref={rootRef} className="wh-confirm-its-you rounded-card border border-line bg-surface p-4">
        <div ref={confirmedRef} tabIndex={-1} role="status" className="flex items-start gap-3 text-sm text-fg">
          <CheckCircle2 aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <p className="min-w-0">{props.confirmedText ?? DEFAULT_CONFIRMED}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="wh-confirm-its-you flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-fg-muted" />
        <p className="min-w-0 text-sm text-fg">
          {props.explanation ?? confirmItsYouExplanation({ passkey: offerPasskey, authenticator: offerAuthenticator })}
        </p>
      </div>
      {state.status === "error" && state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {offerPasskey ? (
        <div className="flex">
          {/* aria-disabled, not disabled, while checking: focus stays on the control. The
              controller already ignores a second tap. */}
          <Button
            type="button"
            variant="primary"
            aria-disabled={working || undefined}
            aria-busy={working || undefined}
            onClick={() => {
              void flow.confirm();
            }}
          >
            <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
            {working ? "Checking…" : "Confirm it's you"}
          </Button>
        </div>
      ) : null}
      {offerAuthenticator ? (
        <form className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => {
          event.preventDefault();
          if (working) return;
          const code = totpCode;
          setTotpCode("");
          void flow.confirmWithTotp(code);
        }}>
          <Field label="Authenticator app code" name="totp" type="text" inputMode="numeric"
            autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} width="short"
            value={totpCode} onChange={(event) => setTotpCode(event.target.value)}
            readOnly={working} />
          <Button type="submit" variant={offerPasskey ? "secondary" : "primary"} aria-disabled={working || undefined}>
            Confirm with authenticator app
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export default ConfirmItsYou;
