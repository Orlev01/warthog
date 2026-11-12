import * as React from "react";

import { Button } from "./button";

// SensitiveNotice — a slow-down panel for a sensitive moment (adding a passport or
// card, approving a payment). Per the brief (design_ux.feel) these moments pause
// with a short, plain explanation of what will happen, and continuing takes the
// person's explicit confirm. Built on the design tokens (globals.css); no raw hex.
// Inside a panel it renders as a muted inset rather than a second card (controls.css).

export type SensitiveNoticeProps = {
  // A plain one or two sentence explanation of what will happen. When omitted, a
  // sensible plain default is shown.
  explanation?: string;
  // Called when the person activates the confirm control (no dead controls).
  onConfirm?: () => void;
  // The confirm control's label (default "Confirm").
  confirmLabel?: string;
  // While the confirmed step runs: the control says so and ignores further taps, but
  // keeps keyboard focus (aria-disabled, never disabled).
  pending?: boolean;
  pendingLabel?: string;
};

// The plain default copy — says what happens in everyday words, with no security
// or protocol jargon (brief design_ux.copy).
const DEFAULT_EXPLANATION = "Check the details are right. Nothing happens until you confirm.";

export function SensitiveNotice({ explanation, onConfirm, confirmLabel = "Confirm", pending = false, pendingLabel = "Working…" }: SensitiveNoticeProps) {
  return (
    <div className="wh-sensitive-notice flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p className="text-sm text-fg">{explanation ?? DEFAULT_EXPLANATION}</p>
      <div className="flex">
        <Button
          type="button"
          variant="primary"
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          onClick={() => {
            if (!pending) onConfirm?.();
          }}
        >
          {pending ? pendingLabel : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
