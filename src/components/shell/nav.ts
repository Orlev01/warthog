// Portal navigation information architecture (the WHAT of the chrome) and the
// active-section resolver — a pure module, no React and no I/O. It is the single
// canonical list of portal destinations: the AppShell (app-shell.tsx) is
// prop-driven and pages pass an `activeSection` string, so both the mobile
// bottom nav and the desktop sidebar read their destinations from here, and
// activeSectionForPath turns the current pathname into the `key` that lights the
// matching item. The `key` values ARE the AppShell `activeSection` values — a
// real cross-task contract, not an arbitrary naming choice.

// A node in the portal IA. A leaf carries its own route (`href`); a group
// carries `children` (and may still carry an `href` that leads into the area).
export type NavNode = {
  readonly key: string;
  readonly label: string;
  readonly href?: string;
  readonly children?: readonly NavNode[];
};

// The Settings sub-pages, in documented order. Settings is one area: every one
// of these lights the single "settings" section (see activeSectionForPath).
const SETTINGS_CHILDREN: readonly NavNode[] = [
  { key: "agent-defaults", label: "Global agent settings", href: "/settings/agents" },
  { key: "security", label: "Security", href: "/settings/security" },
  { key: "notifications", label: "Notifications", href: "/settings/notifications" },
  { key: "data", label: "Data & privacy", href: "/settings/data" },
];

// The "More" group — reachable directly in the desktop sidebar and behind "More"
// on mobile. Copy and routes per the brief (design_ux) and technical-design §1.
const MORE_CHILDREN: readonly NavNode[] = [
  { key: "vault", label: "Vault", href: "/vault" },
  { key: "connectors", label: "Connectors", href: "/connectors" },
  { key: "rules", label: "Rules & budgets", href: "/rules" },
  { key: "spending", label: "Spending", href: "/spending" },
  { key: "skills", label: "Skills", href: "/skills" },
  { key: "memory", label: "Memory", href: "/memory" },
  { key: "life-admin", label: "Life admin", href: "/life-admin" },
  { key: "household", label: "Household", href: "/household" },
  { key: "settings", label: "Settings", href: "/settings", children: SETTINGS_CHILDREN },
  { key: "help", label: "Help", href: "/help" },
];

// The portal IA: the five primary sections in documented left-to-right order.
// Home, Inbox, Activity and Agents are leaves; More groups the rest.
export const PORTAL_NAV: readonly NavNode[] = [
  { key: "home", label: "Home", href: "/home" },
  { key: "inbox", label: "Inbox", href: "/inbox" },
  { key: "activity", label: "Activity", href: "/activity" },
  { key: "agents", label: "Agents", href: "/agents" },
  { key: "more", label: "More", href: "/more", children: MORE_CHILDREN },
];

// The sections the resolver can light: the five primary sections plus the ten
// destinations grouped under More. Settings is treated as one area — its own
// sub-pages all light "settings" — so we never descend into Settings' children.
const RESOLVABLE: readonly NavNode[] = [
  ...PORTAL_NAV,
  ...(PORTAL_NAV.find((n) => n.key === "more")?.children ?? []),
];

// Strip a trailing slash (never from the root) so "/home/" owns the same section
// as "/home". A non-string or empty input normalises to "" and owns nothing.
function normalizePath(pathname: string): string {
  if (typeof pathname !== "string" || pathname.length === 0) return "";
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

// A section whose route is `base` owns `path` only at a segment boundary, so a
// sibling that merely shares a prefix ("/homework", "/vaultage") is not caught.
function owns(base: string, path: string): boolean {
  return path === base || path.startsWith(base + "/");
}

// The `key` of the section a portal path belongs to, or null for a path the IA
// does not own. A section owns its route and everything beneath it; the portal
// root "/" resolves to Home. Never throws, whatever path it is given.
export function activeSectionForPath(pathname: string): string | null {
  const path = normalizePath(pathname);
  if (path === "/") return "home";

  // Longest owning route wins, so the most specific section lights.
  let match: NavNode | null = null;
  for (const section of RESOLVABLE) {
    const base = section.href;
    if (base === undefined || !owns(base, path)) continue;
    if (match === null || base.length > (match.href?.length ?? 0)) match = section;
  }
  return match ? match.key : null;
}
