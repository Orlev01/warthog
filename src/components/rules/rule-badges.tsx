import * as React from "react";
import { Ban, CircleCheck, MessageCircleQuestion, PauseCircle, type LucideIcon } from "lucide-react";

import type { RuleKind } from "@/domain/rules/rules";

// A rule's kind and lifecycle status, each as a word plus an icon (never colour alone),
// shared by the Rules page and the agent workspace's Rules section so both read the same.
// Icons are decorative; the word is the accessible name. Colours are tone tokens.

const KIND_META: Record<RuleKind, { label: string; Icon: LucideIcon; tone: string }> = {
  ask_first: { label: "Ask first", Icon: MessageCircleQuestion, tone: "text-warning" },
  never_allow: { label: "Never allow", Icon: Ban, tone: "text-danger" },
};

export function RuleKindBadge({ kind }: { kind: RuleKind }) {
  const { label, Icon, tone } = KIND_META[kind];
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs font-medium text-fg">
      <Icon aria-hidden={true} className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
      {label}
    </span>
  );
}

export function RuleStatusLabel({ status }: { status: "active" | "paused" }) {
  return status === "paused" ? (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted">
      <PauseCircle aria-hidden={true} className="h-4 w-4 shrink-0" />
      Paused
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg">
      <CircleCheck aria-hidden={true} className="h-4 w-4 shrink-0 text-success" />
      Active
    </span>
  );
}
