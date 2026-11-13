// The admin portal's information architecture (docs/design/admin-portal.md §5) — a pure
// module, no React and no I/O: the grouped destinations the AdminChrome hands AppShell, the
// active-section resolver over the ORIGINAL un-prefixed path the proxy forwards, and each
// section family's page measure. Every href is un-prefixed because on the admin host the
// proxy rewrites `/usage` to `/admin/usage`; nothing here knows about that prefix.

import { Activity, Globe, LayoutDashboard, Server, ShieldAlert, UserPlus, Users, type LucideIcon } from "lucide-react";
import type { NavGroup, PageMeasure } from "@/components/shell/workspace-navigation";

export const ADMIN_ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  signups: UserPlus,
  usage: Activity,
  accounts: Users,
  reliability: ShieldAlert,
  traffic: Globe,
  system: Server,
};

export const ADMIN_NAV_GROUPS: readonly NavGroup[] = [
  { label: "Overview", items: [{ key: "overview", label: "Overview", href: "/" }], hideLabel: true },
  {
    label: "Product",
    items: [
      { key: "signups", label: "Sign-ups", href: "/signups" },
      { key: "usage", label: "Usage", href: "/usage" },
      { key: "accounts", label: "Accounts", href: "/accounts" },
    ],
  },
  {
    label: "Health",
    items: [
      { key: "reliability", label: "Reliability", href: "/reliability" },
      { key: "traffic", label: "Traffic", href: "/traffic" },
      { key: "system", label: "System", href: "/system" },
    ],
  },
];

const DESTINATIONS = ADMIN_NAV_GROUPS.flatMap((group) => group.items);

const MEASURES: Readonly<Record<string, PageMeasure>> = {
  overview: "wide",
  signups: "wide",
  usage: "wide",
  reliability: "wide",
  traffic: "wide",
  accounts: "reading",
  system: "reading",
};

function normalizePath(pathname: string): string {
  if (typeof pathname !== "string" || pathname.length === 0) return "";
  const path = pathname.split("?")[0]!;
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** The section key an admin path belongs to (longest owning route; "/" is Overview), or null. */
export function activeAdminSection(pathname: string): string | null {
  const path = normalizePath(pathname);
  if (path === "/" ) return "overview";
  let match: { key: string; href: string } | null = null;
  for (const item of DESTINATIONS) {
    if (item.href === "/" || !item.href) continue;
    if (path === item.href || path.startsWith(`${item.href}/`)) {
      if (match === null || item.href.length > match.href.length) match = { key: item.key, href: item.href };
    }
  }
  return match ? match.key : null;
}

/** The page width for an admin section: dashboards wide, Accounts and System reading. */
export function adminMeasureFor(section: string | null): PageMeasure {
  return (section && MEASURES[section]) || "reading";
}
