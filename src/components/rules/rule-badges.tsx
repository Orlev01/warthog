import * as React from "react";
import { Ban, CircleCheck, MessageCircleQuestion, PauseCircle, type LucideIcon } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { RuleKind } from "@/domain/rules/rules";

// A rule's kind and lifecycle status, each as a word plus an icon (never colour alone),
// shared by the Rules page and the agent workspace's Rules section so both read the same.
// Icons are decorative; the word is the accessible name. The kind is the shared Badge (one
// 20px pill everywhere, controls.css); the words are the house voice ("Ask me first").

const KIND_META: Record<RuleKind, { label: string; Icon: LucideIcon; tone: BadgeTone }> = {
  ask_first: { label: "Ask me first", Icon: MessageCircleQuestion, tone: "warning" },
  never_allow: { label: "Never allow", Icon: Ban, tone: "danger" },
};

export function RuleKindBadge({ kind }: { kind: RuleKind }) {
  const { label, Icon, tone } = KIND_META[kind];
  return (
    <Badge tone={tone} icon={Icon} className="w-fit">
      {label}
    </Badge>
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
