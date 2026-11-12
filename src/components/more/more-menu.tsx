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

import { PORTAL_NAV, type NavNode } from "@/components/shell/nav";
import { SignOutControl } from "@/components/shell/sign-out";
import { NAV_GROUPS } from "@/components/shell/workspace-navigation";
import { ListGroup } from "@/components/ui/list-group";

// MoreMenu keeps the legacy /more route useful for bookmarks. The grouped desktop
// sidebar and mobile drawer now expose these destinations directly.
//
// The destinations — their labels and IA routes — come from the ONE source of truth,
// the portal IA (`@/components/shell/nav`): this component reads the "more" node's
// children and hard-codes no parallel list of destinations. They are grouped exactly
// as the sidebar groups them (`NAV_GROUPS`, workspace-navigation.ts), in its order,
// rather than one long flat list; a destination no sidebar group holds lands in a
// trailing "Other" group, so none is ever dropped. The only thing this adds is the
// decorative icon beside each label, chosen by the IA `key` (the stable cross-task
// contract the app shell lights its nav from), since the IA itself carries no icon.
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

// The "More" children straight from the IA.
const MORE_CHILDREN = PORTAL_NAV.find((n) => n.key === "more")?.children ?? [];

// The "More" children in the sidebar's groups and order. Each group keeps only its
// "More" destinations (the primary sections live in the sidebar already); groups left
// empty are skipped; anything the sidebar does not group is kept under "Other".
const MORE_KEYS = new Set(MORE_CHILDREN.map((child) => child.key));
const GROUPED_KEYS = new Set(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.key)));
const MORE_GROUPS: ReadonlyArray<{ label: string; items: readonly NavNode[] }> = [
  ...NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => MORE_KEYS.has(item.key)),
  })),
  { label: "Other", items: MORE_CHILDREN.filter((child) => !GROUPED_KEYS.has(child.key)) },
].filter((group) => group.items.length > 0);

function groupId(label: string): string {
  return `more-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function MoreMenu() {
  return (
    <div className="wh-page flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">More</h1>

      <nav aria-label="More" className="flex flex-col gap-6">
        {MORE_GROUPS.map((group) => (
          <ListGroup key={group.label} id={groupId(group.label)} title={group.label}>
            {group.items.map((child) => {
              const Icon = ICONS[child.key] ?? MoreHorizontal;
              return (
                <li key={child.key} className="border-b border-line last:border-0">
                  <a
                    href={child.href}
                    className="flex min-h-11 items-center gap-3 rounded-field px-2 py-3 text-sm font-medium text-fg hover:bg-surface-muted"
                  >
                    <Icon aria-hidden={true} className="h-5 w-5 shrink-0" />
                    <span>{child.label}</span>
                  </a>
                </li>
              );
            })}
          </ListGroup>
        ))}
      </nav>

      {/* Sign out — the mobile twin of the desktop sidebar's footer control. On
          mobile the More menu is the only way into these sections, so this is
          where a person signs out of the device they are using. */}
      <SignOutControl className="border border-line bg-surface px-4 py-3" />
    </div>
  );
}
