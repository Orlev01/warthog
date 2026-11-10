import * as React from "react";
import { Bell, Database, Lock, Settings, type LucideIcon } from "lucide-react";

import { PORTAL_NAV } from "@/components/shell/nav";

// SettingsIndex — the /settings index (E18-S15). Settings is one area grouping
// three screens; landing on /settings would otherwise dead-end, so this screen
// lists each settings screen as a full-width link, exactly the list the desktop
// sidebar shows inline under Settings.
//
// The destinations — their labels and IA routes, in order — come from the ONE
// source of truth, the portal IA (`@/components/shell/nav`): this component reads
// the "settings" node's children (under "more") and hard-codes no parallel list
// of destinations. The IA carries no per-screen description, so the view supplies
// a one-line plain-English line beside each label, and a decorative icon chosen by
// the IA `key`.
//
// A plain, propless, synchronously-renderable view: the thin `/settings` page
// loader inside the already-guarded `(protected)` group mounts it, exactly as
// `/more` mounts <MoreMenu>. Colour, radius and focus come from the design tokens
// (globals.css), never a raw value.

// The icon for each settings destination, keyed on its IA `key`. A key the IA adds
// without an icon here falls back to the Settings glyph rather than crashing.
const ICONS: Record<string, LucideIcon> = {
  security: Lock,
  notifications: Bell,
  data: Database,
};

// The one-line, plain-English description for each settings destination, keyed on
// its IA `key` — what the screen is for, so the destinations are self-explaining.
const DESCRIPTIONS: Record<string, string> = {
  "agent-defaults": "Set defaults for new agents and review controls that apply to all agents.",
  security: "Manage your passkey and second factor for signing in.",
  notifications: "Choose how Warthog lets you know about approvals and alerts.",
  data: "Export everything Warthog holds, or delete your account.",
};

// The settings children straight from the IA, in IA order.
const SETTINGS_CHILDREN =
  PORTAL_NAV.find((n) => n.key === "more")?.children?.find((c) => c.key === "settings")?.children ??
  [];

export function SettingsIndex() {
  return (
    <div className="wh-page flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Settings</h1>

      <nav aria-label="Settings" className="flex flex-col gap-2">
        {SETTINGS_CHILDREN.map((child) => {
          const Icon = ICONS[child.key] ?? Settings;
          return (
            <a
              key={child.key}
              href={child.href}
              className="flex min-h-11 items-start gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm text-fg hover:bg-surface-muted"
            >
              <Icon aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0" />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{child.label}</span>
                <span className="text-fg-muted">{DESCRIPTIONS[child.key] ?? ""}</span>
              </span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
