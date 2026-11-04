import * as React from "react";
import { AlertTriangle, CheckCircle, Clock, RefreshCw, type LucideIcon } from "lucide-react";

// Status — a connection/approval status indicator, built on the design tokens
// (globals.css). The meaning is carried by WORDS plus an ICON, never by colour
// alone (brief design_ux.feel: "status shown with words and icons not colour
// alone"). The icon is decorative (aria-hidden) so a screen reader announces the
// label, not a mystery graphic. Colour comes from tone tokens, never raw hex.

export type StatusKey = "connected" | "needs-reconnect" | "error" | "pending";

type StatusMeta = {
  // The visible, accessible label — distinct per status. "Reconnect needed" is
  // Warthog's documented copy for the needs-reconnect state (CLAUDE.md vocab).
  label: string;
  Icon: LucideIcon;
  // A token-based text colour; the decorative icon inherits it via currentColor.
  tone: string;
};

const STATUS_META: Record<StatusKey, StatusMeta> = {
  connected: { label: "Connected", Icon: CheckCircle, tone: "text-success" },
  "needs-reconnect": { label: "Reconnect needed", Icon: RefreshCw, tone: "text-warning" },
  error: { label: "Error", Icon: AlertTriangle, tone: "text-danger" },
  pending: { label: "Pending", Icon: Clock, tone: "text-fg-muted" },
};

export type StatusProps = {
  status: StatusKey;
};

export function Status({ status }: StatusProps) {
  const { label, Icon, tone } = STATUS_META[status];
  return (
    <span className={["inline-flex items-center gap-1.5 text-sm font-medium", tone].join(" ")}>
      <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
      {label}
    </span>
  );
}
