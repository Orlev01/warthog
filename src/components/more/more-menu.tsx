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

// MoreMenu — the mobile "More" menu (brief design_ux, technical-design §12). On
// mobile the bottom nav's "More" tab is the only way into the More sections, so
// this screen lists every one of them as a full-width link, keeping everything
// two taps away. The desktop sidebar shows these same children inline, so this
// page is the mobile counterpart of that list.
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
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
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
    </div>
  );
}
