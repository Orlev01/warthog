import * as React from "react";
import {
  Brain,
  ClipboardList,
  HelpCircle,
  Lock,
  MoreHorizontal,
  Plug,
  Settings,
  Sparkles,
  SlidersHorizontal,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { PORTAL_NAV } from "@/components/shell/nav";
import { SignOutControl } from "@/components/shell/sign-out";

// MoreMenu keeps the legacy /more route useful for bookmarks. The grouped desktop
// sidebar and mobile drawer now expose these destinations directly.
//
// The destinations — their labels and IA routes, in order — come from the ONE
// source of truth, the portal IA (`@/components/shell/nav`): this component reads
// the "more" node's children and hard-codes no parallel list of destinations. The
// only thing it adds is the decorative icon beside each label, chosen by the IA
// `key` (the stable cross-task contract the app shell lights its nav from), since
// the IA itself carries no icon.
//
// A plain, propless, synchronously-renderable view: the thin `/more` page loader
// inside the already-guarded `(protected)` group mounts it, exactly as the home
// page mounts <DashboardView>. Colour, radius and focus come from the design
// tokens (globals.css), never a raw value.

// The icon for each "More" destination, keyed on its IA `key`. A key the IA adds
// without an icon here falls back to the "More" glyph rather than crashing.
const ICONS: Record<string, LucideIcon> = {
  vault: Lock,
  connectors: Plug,
  rules: SlidersHorizontal,
  spending: Wallet,
  skills: Sparkles,
  memory: Brain,
  "life-admin": ClipboardList,
  household: Users,
  settings: Settings,
  help: HelpCircle,
};

// The "More" children straight from the IA, in IA order.
const MORE_CHILDREN = PORTAL_NAV.find((n) => n.key === "more")?.children ?? [];

export function MoreMenu() {
  return (
    <div className="wh-page flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">More</h1>

      <nav aria-label="More" className="flex flex-col gap-2">
        {MORE_CHILDREN.map((child) => {
          const Icon = ICONS[child.key] ?? MoreHorizontal;
          return (
            <a
              key={child.key}
              href={child.href}
              className="flex min-h-11 items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm font-medium text-fg hover:bg-surface-muted"
            >
              <Icon aria-hidden={true} className="h-5 w-5 shrink-0" />
              <span>{child.label}</span>
            </a>
          );
        })}
      </nav>

      {/* Sign out — the mobile twin of the desktop sidebar's footer control. On
          mobile the More menu is the only way into these sections, so this is
          where a person signs out of the device they are using. */}
      <SignOutControl className="border border-line bg-surface px-4 py-3" />
    </div>
  );
}
