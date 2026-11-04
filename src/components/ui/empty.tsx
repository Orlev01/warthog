import * as React from "react";

// EmptyState — a centred empty-state panel for list screens with nothing to show
// yet (technical-design §11), built on the design tokens (globals.css). The
// heading lives in a real <h2> so a screen reader can jump to it; the action is
// optional so a screen with no next step renders no dead control. Colour comes
// from tokens, never raw hex.

export type EmptyStateProps = {
  heading: string;
  description: string;
  action?: React.ReactNode;
};

export function EmptyState({ heading, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-line bg-surface p-8 text-center">
      <h2 className="text-lg font-semibold text-fg">{heading}</h2>
      <p className="text-sm text-fg-muted">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
