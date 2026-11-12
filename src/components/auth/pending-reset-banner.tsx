"use client";

import * as React from "react";

import { Button } from "../ui/button";
import { Notice } from "../ui/notice";
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

  // Both states sit on the page grid as a page-level notice (desktop-07): the same measure and
  // gutters as the page below, never bare text on the canvas. The slot drops its bottom
  // padding so it shares the page's own rhythm.
  if (state === "cancelled") {
    return (
      <div className="wh-page" style={{ paddingBottom: 0 }}>
        <Notice tone="success" className="wh-page-notice">The reset is cancelled. Nothing will be erased.</Notice>
      </div>
    );
  }

  return (
    <div className="wh-page" style={{ paddingBottom: 0 }}>
      <Notice tone="error" className="wh-page-notice">
        <div className="flex flex-col gap-3">
          <p>
            A reset of your account was asked for on {formatAccountTime(requestedAt, timeZone)}. On {formatAccountTime(completesAt, timeZone)} it will
            erase your saved cards and protected details and disconnect your agents. If this wasn&apos;t you,
            cancel it now.
          </p>
          {error ? <p className="text-danger">{error}</p> : null}
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
      </Notice>
    </div>
  );
}

export default PendingResetBanner;
