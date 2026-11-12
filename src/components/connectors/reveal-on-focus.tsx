"use client";
import * as React from "react";

// Keeps a keyboard-focused item fully visible inside a horizontally scrolling row (the
// catalogue's category chips on phones and at high zoom). Browsers skip their own focus
// scroll when the item is already partly in view, which leaves a sliver of the focus ring
// at the track's edge (WCAG 2.4.11 Focus Not Obscured). Only the nearest scroll container
// moves as needed; nothing changes for pointer users or before hydration.
export function RevealOnFocus({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-w-0"
      onFocus={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches(":focus-visible")) {
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }}
    >
      {children}
    </div>
  );
}
