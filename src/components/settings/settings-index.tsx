import * as React from "react";
import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";
import { Bell, ChevronRight, Database, Lock, MessageSquareText, Settings, SlidersHorizontal, type LucideIcon } from "lucide-react";

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
  "agent-defaults": SlidersHorizontal,
  security: Lock,
  notifications: Bell,
  data: Database,
};

// The one-line, plain-English description for each settings destination, keyed on
// its IA `key` — what the screen is for, so the destinations are self-explaining.
const DESCRIPTIONS: Record<string, string> = {
  "agent-defaults": "Starting permissions for agents you connect from now on.",
  security: "Manage your passkeys, recovery code and where you're signed in.",
  notifications: "Choose how Warthog lets you know about approvals and alerts.",
  data: "Export or import your data, or delete your account.",
};

// How agents write for you lives with your skills; it's linked here too because it's where
// people look for it (newcomer-10). The route is the Skills page's Preferences tab.
const PREFERENCES = {
  key: "preferences",
  label: "Preferences",
  href: "/skills?view=preferences",
  description: "How agents write for you: tone, length, language, units and time zone.",
};

// The settings children straight from the IA, in IA order.
const SETTINGS_CHILDREN =
  PORTAL_NAV.find((n) => n.key === "more")?.children?.find((c) => c.key === "settings")?.children ??
  [];

export function SettingsIndex() {
  const links = [
    ...SETTINGS_CHILDREN.map((child) => ({
      key: child.key,
      label: child.label,
      href: child.href,
      description: DESCRIPTIONS[child.key] ?? "",
      Icon: ICONS[child.key] ?? Settings,
    })),
    { ...PREFERENCES, Icon: MessageSquareText },
  ];
  return (
    <div className="wh-page">
      <WorkspaceHeading title="Settings" description="Keep your account secure, choose how you hear from Warthog and manage your data." />

      <nav aria-label="Settings" className="wh-settings-links">
        {links.map(({ key, label, href, description, Icon }) => (
          <a
            key={key}
            href={href}
            className={`wh-surface wh-settings-link text-sm text-fg${key === PREFERENCES.key ? " sm:col-span-2" : ""}`}
          >
            <span className="wh-object-icon"><Icon aria-hidden size={18} strokeWidth={1.7} /></span>
            <span className="flex flex-col gap-1">
              <span className="font-medium">{label}</span>
              <span className="text-fg-muted">{description}</span>
            </span>
            <ChevronRight aria-hidden size={16} />
          </a>
        ))}
      </nav>
    </div>
  );
}
