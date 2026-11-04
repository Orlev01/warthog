import * as React from "react";

import { Button } from "./button";

// SensitiveNotice — a slow-down panel for a sensitive moment (adding a passport or
// card, approving a payment). Per the brief (design_ux.feel) these moments pause
// with a short, plain explanation of what will happen, and continuing takes the
// person's explicit confirm. Built on the design tokens (globals.css); no raw hex.

export type SensitiveNoticeProps = {
  // A plain one or two sentence explanation of what will happen. When omitted, a
  // sensible plain default is shown.
  explanation?: string;
  // Called when the person activates the confirm control (no dead controls).
  onConfirm?: () => void;
};

// The plain default copy — says what happens in everyday words, with no security
// or protocol jargon (brief design_ux.copy).
const DEFAULT_EXPLANATION =
  "This is a sensitive step, so take a moment before it goes ahead. Check the details are right, then confirm to continue.";

export function SensitiveNotice({ explanation, onConfirm }: SensitiveNoticeProps) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p className="text-sm text-fg">{explanation ?? DEFAULT_EXPLANATION}</p>
      <div className="flex">
        <Button type="button" variant="primary" onClick={onConfirm}>
          Confirm
        </Button>
      </div>
    </div>
  );
}
