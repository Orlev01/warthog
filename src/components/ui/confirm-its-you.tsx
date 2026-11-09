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
  // Why a fresh confirmation is needed here, in plain words.
  explanation?: string;
  // Shown once confirmed (e.g. "Done — you can export now.").
  confirmedText?: string;
  onConfirmed?: () => void;
  // Browser seams, overridable for tests.
  fetch?: typeof fetch;
  startAuthentication?: ConfirmItsYouDeps["startAuthentication"];
}

const DEFAULT_EXPLANATION =
  "This is a sensitive step, so we need to check it's really you. Use your passkey or your enrolled authenticator app.";
const DEFAULT_CONFIRMED = "Thanks — that's confirmed. You can carry on for the next five minutes.";

export function ConfirmItsYou(props: ConfirmItsYouProps): React.ReactElement {
  const [totpCode, setTotpCode] = React.useState("");
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
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

  const confirmation = state.status === "confirmed" ? (
      <div
        role="status"
        className="flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-sm text-fg"
      >
        <CheckCircle2 aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-success" />
        <p>{props.confirmedText ?? DEFAULT_CONFIRMED}</p>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      {confirmation}
      <p className="text-sm text-fg">{props.explanation ?? DEFAULT_EXPLANATION}</p>
      {state.status === "error" && state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div className="flex">
        <Button
          type="button"
          variant="primary"
          disabled={state.status === "working"}
          onClick={() => {
            void flow.confirm();
          }}
        >
          <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
          {state.status === "working" ? "Checking…" : "Confirm it's you"}
        </Button>
      </div>
      <form className="flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault();
        const code = totpCode;
        setTotpCode("");
        void flow.confirmWithTotp(code);
      }}>
        <Field label="Authenticator app code" name="totp" type="text" inputMode="numeric"
          autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6}
          value={totpCode} onChange={(event) => setTotpCode(event.target.value)}
          disabled={state.status === "working"} />
        <Button type="submit" variant="secondary" disabled={state.status === "working"}>
          Confirm with authenticator app
        </Button>
      </form>
    </div>
  );
}

export default ConfirmItsYou;
