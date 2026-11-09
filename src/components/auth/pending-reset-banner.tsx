"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Button } from "../ui/button";
import { formatAccountTime } from "@/domain/display-time";

// Review fix W3.3 — the banner every signed-in screen shows while an account reset is
// pending (the brief: the reset "can be cancelled from any signed-in device"). It names
// when the reset was asked for and when it will finish, and offers a real Cancel button
// that posts to /api/auth/reset/cancel (the session cookie says whose reset; nothing else
// is sent). The outcome is announced in plain words; icons back up the words, never colour
// alone.

export type CancelResetResult = { ok: true } | { ok: false; error: string };

const CANCEL_FAILED_COPY = "We couldn't cancel the reset just now. Please try again.";

// The cancel request, injectable for tests. Nothing left to cancel (404) is a success:
// the reset is not going ahead either way.
export function createCancelReset(fetchImpl: typeof fetch): () => Promise<CancelResetResult> {
  return async () => {
    try {
      const response = await fetchImpl("/api/auth/reset/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (response.ok || response.status === 404) return { ok: true };
    } catch {
      /* offline: reported below */
    }
    return { ok: false, error: CANCEL_FAILED_COPY };
  };
}

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export interface PendingResetBannerProps {
  readonly requestedAt: string;
  readonly completesAt: string;
  readonly timeZone?: string;
  readonly fetch?: typeof fetch;
}

export function PendingResetBanner({ requestedAt, completesAt, timeZone, fetch: fetchImpl }: PendingResetBannerProps) {
  const [state, setState] = React.useState<"pending" | "busy" | "cancelled">("pending");
  const [error, setError] = React.useState<string | undefined>(undefined);
  const cancel = React.useMemo(() => createCancelReset(fetchImpl ?? defaultFetch), [fetchImpl]);

  if (state === "cancelled") {
    return (
      <div role="status" className="mx-auto flex w-full max-w-3xl items-start gap-3 px-4 pt-6 text-sm text-fg sm:px-6">
        <CheckCircle2 aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0" />
        <p>The reset is cancelled. Nothing will be erased.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6">
      <div role="alert" className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4 text-sm text-fg">
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            A reset of your account was asked for on {formatAccountTime(requestedAt, timeZone)}. On {formatAccountTime(completesAt, timeZone)} it will
            erase your saved cards and protected details and disconnect your agents. If this wasn&apos;t you,
            cancel it now.
          </p>
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div>
          <Button
            type="button"
            variant="primary"
            aria-busy={state === "busy" ? true : undefined}
            onClick={() => {
              if (state === "busy") return;
              setState("busy");
              void cancel().then((result) => {
                if (result.ok) {
                  setState("cancelled");
                } else {
                  setError(result.error);
                  setState("pending");
                }
              });
            }}
          >
            Cancel the reset
          </Button>
        </div>
      </div>
    </div>
  );
}

export default PendingResetBanner;
