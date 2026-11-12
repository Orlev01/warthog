import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Info } from "lucide-react";

// EmptyState — "nothing here yet", always bounded and always pointing at the next step
// (technical-design §11). Two placements:
//   • `page` (default): a list screen with nothing to show; a panel-level dashed card with
//     a real heading, one sentence on what will appear and why it's empty now, and one action.
//   • `inline`: an empty group inside a panel or list group; an icon, a sentence and the
//     action as a quiet row in that surface's body, so it never becomes card-in-card.
// The action is optional so a screen with no next step renders no dead control. Colour comes
// from tokens, never raw hex (styles: surfaces.css, .wh-empty / .wh-panel-empty).

export type EmptyStateProps = {
  heading: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: LucideIcon;
  // Heading level for the page variant; the inline variant's heading is bold text.
  headingLevel?: 2 | 3;
  variant?: "page" | "inline";
};

export function EmptyState({
  heading,
  description,
  action,
  icon: Icon,
  headingLevel = 2,
  variant = "page",
}: EmptyStateProps) {
  if (variant === "inline") {
    const Glyph = Icon ?? Info;
    return (
      <div className="wh-panel-empty">
        <Glyph aria-hidden size={18} strokeWidth={1.7} />
        <div className="wh-panel-empty-copy">
          <p className="wh-panel-empty-title">{heading}</p>
          {description ? <p>{description}</p> : null}
          {action ? <div className="wh-panel-empty-action">{action}</div> : null}
        </div>
      </div>
    );
  }
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <div className="wh-card wh-empty flex flex-col items-center gap-3 rounded-card border border-line bg-surface p-6 text-center sm:p-8">
      {Icon ? (
        <span className="wh-empty-icon">
          <Icon aria-hidden size={20} strokeWidth={1.7} />
        </span>
      ) : null}
      <Heading className="text-lg font-semibold text-fg">{heading}</Heading>
      {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
