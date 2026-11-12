import * as React from "react";
import type { LucideIcon } from "lucide-react";

// Badge, CountBadge — the one small label primitive: outcomes ("Allowed", "Asked you
// first"), markings ("Reads", "Makes changes"), tags and counts. Every badge is the same
// 20px pill with 12px text, so the same token never changes height or corner between
// pages (controls.css `.wh-badge`). A tone adds a soft fill and colours only the icon; the
// words carry the meaning, never the colour alone. Tones come from workspace.css.

export type BadgeTone = "neutral" | "info" | "tint" | "success" | "warning" | "danger";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  // A decorative 12px icon before the words.
  icon?: LucideIcon;
};

export function Badge({ tone = "neutral", icon: Icon, className, children, ...props }: BadgeProps) {
  return (
    <span className={["wh-badge wh-tone-badge", `wh-tone-${tone}`, className].filter(Boolean).join(" ")} {...props}>
      {Icon ? <Icon aria-hidden={true} className="h-3 w-3 shrink-0" /> : null}
      {children}
    </span>
  );
}

export type CountBadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  count: number;
  // Read instead of the bare number, e.g. "3 waiting". Defaults to the number.
  label?: string;
};

/** A count next to a tab, filter or group heading. */
export function CountBadge({ count, label, className, ...props }: CountBadgeProps) {
  return (
    <span className={["wh-count", className].filter(Boolean).join(" ")} {...props}>
      {label ? (
        <>
          <span aria-hidden={true}>{count}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        count
      )}
    </span>
  );
}
