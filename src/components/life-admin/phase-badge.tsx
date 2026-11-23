import * as React from "react";
import {
  AlertTriangle,
  Archive,
  CalendarCheck,
  CalendarClock,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleHelp,
  CirclePause,
  CircleX,
  Hourglass,
  PlayCircle,
  TimerOff,
  UserX,
  type LucideIcon,
} from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { Phase } from "@/domain/life-admin/lifecycle";

// Where a record stands, as words and an icon (never colour alone): the phase's own label
// from the lifecycle module ("Happening now", "Overdue", "Waiting to be confirmed").

const PHASE_LOOK: Readonly<Record<Phase, { icon: LucideIcon; tone: BadgeTone }>> = {
  current: { icon: CircleCheck, tone: "neutral" },
  due_soon: { icon: CalendarClock, tone: "info" },
  overdue: { icon: AlertTriangle, tone: "warning" },
  date_passed: { icon: CircleHelp, tone: "warning" },
  paused: { icon: CirclePause, tone: "neutral" },
  ended: { icon: Archive, tone: "neutral" },
  pending: { icon: Hourglass, tone: "warning" },
  lapsed: { icon: TimerOff, tone: "neutral" },
  upcoming: { icon: CalendarClock, tone: "info" },
  in_progress: { icon: PlayCircle, tone: "success" },
  completed: { icon: CalendarCheck, tone: "neutral" },
  cancelled: { icon: CircleX, tone: "neutral" },
  missed: { icon: UserX, tone: "neutral" },
  open: { icon: CircleDot, tone: "info" },
  waiting: { icon: Hourglass, tone: "neutral" },
  resolved: { icon: CircleCheckBig, tone: "success" },
};

export function phaseIcon(phase: Phase): LucideIcon {
  return PHASE_LOOK[phase]?.icon ?? CircleDot;
}

export function PhaseBadge({ phase, label }: { phase: Phase; label: string }) {
  const look = PHASE_LOOK[phase] ?? { icon: CircleDot, tone: "neutral" as const };
  return (
    <Badge tone={look.tone} icon={look.icon}>
      {label}
    </Badge>
  );
}
