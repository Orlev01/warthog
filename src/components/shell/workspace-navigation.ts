import { PORTAL_NAV, activeSectionForPath, type NavNode } from "./nav";
import {
  AGENT_SECTIONS,
  type AgentSection,
} from "@/domain/permissions/workspace";

const destinations = [
  ...PORTAL_NAV,
  ...(PORTAL_NAV.find((n) => n.key === "more")?.children ?? []),
];
const item = (key: string) => destinations.find((n) => n.key === key)!;
// Sidebar groups. Every group name is distinct; "Resources" belongs to an agent's own
// resources (AGENT_GROUPS below), so the account-level group is "Account resources" and the
// help group is "Help". A one-item group whose label would only repeat its item
// (`hideLabel`) keeps the label as the group's accessible name but shows a divider instead.
export type NavGroup = {
  readonly label: string;
  readonly items: readonly NavNode[];
  readonly hideLabel?: boolean;
};
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: "Workspace", items: ["home", "agents", "inbox"].map(item) },
  {
    label: "Account resources",
    items: ["connectors", "vault", "skills", "memory", "life-admin"].map(item),
  },
  { label: "Insights", items: ["activity", "spending"].map(item) },
  { label: "Manage", items: ["rules", "household", "settings"].map(item) },
  { label: "Help", items: ["help", "contact"].map(item) },
];

// The group that owns a section key within any grouped IA (the member portal's NAV_GROUPS or
// the admin portal's groups), for the breadcrumb and page eyebrows.
export function navGroupIn(groups: readonly NavGroup[], section: string): NavGroup | undefined {
  return groups.find((g) => g.items.some((i) => i.key === section));
}

// The sidebar group that owns a section key in the member portal's IA.
export function navGroupFor(section: string): NavGroup | undefined {
  return navGroupIn(NAV_GROUPS, section);
}

// One page width per section family, so sibling route tabs never move the page's left
// edge. AppShell publishes it as `data-measure` on the main column; every .wh-page and the
// chrome above it (top bar, route tabs, scope strip) read the same measure, so they share
// one left and right edge at every width.
//   wide    1216px  dashboards, timelines and catalogues: Home, Activity, Spending, Connectors
//   reading  896px  lists and detail pages: Agents (all), Inbox, Vault, Memory, Skills,
//                   Life admin, Rules, Household, More, Contact us, Connectors › API key
//   form     768px  focused settings forms: every Settings page
export type PageMeasure = "wide" | "reading" | "form";
const SECTION_MEASURE: Readonly<Record<string, PageMeasure>> = {
  home: "wide",
  activity: "wide",
  spending: "wide",
  connectors: "wide",
  agents: "reading",
  inbox: "reading",
  vault: "reading",
  memory: "reading",
  skills: "reading",
  "life-admin": "reading",
  rules: "reading",
  household: "reading",
  more: "reading",
  contact: "reading",
  settings: "form",
};
export function pageMeasureFor(pathname: string): PageMeasure | undefined {
  const path = pathname.replace(/\/$/, "") || "/";
  if (path === "/connectors/key" || path.startsWith("/connectors/key/")) return "reading";
  const section = activeSectionForPath(path);
  return section ? SECTION_MEASURE[section] : undefined;
}

export type NavigationLink = { label: string; href: string; active: boolean };
export function sectionNavigation(pathname: string): {
  label: string;
  items: NavigationLink[];
} {
  const normalizedPath = pathname.replace(/\/$/, "") || "/";
  const path = normalizedPath === "/agents/access-key" ? "/agents/connect" : normalizedPath;
  const section = activeSectionForPath(path);
  let label = "";
  let links: readonly (readonly [string, string])[] = [];
  if (section === "settings") {
    label = "Settings";
    links = [
      ["Overview", "/settings"],
      ["Agent defaults", "/settings/agents"],
      ["Security", "/settings/security"],
      ["Notifications", "/settings/notifications"],
      ["Data & privacy", "/settings/data"],
    ];
  } else if (section === "vault") {
    label = "Vault";
    links = [
      ["About you", "/vault"],
      ["Cards", "/vault/cards"],
    ];
  } else if (section === "memory" || section === "skills") {
    label = "Memory and skills";
    links = [
      ["Memory", "/memory"],
      ["Skills", "/skills"],
    ];
  } else if (section === "activity" || section === "spending") {
    label = "Insights";
    links = [
      ["Activity", "/activity"],
      ["Spending", "/spending"],
    ];
  } else if (path === "/agents" || path === "/agents/now" || path === "/agents/connect") {
    label = "Agents";
    links = [
      ["Your agents", "/agents"],
      // Every agent's recent conversations (docs/adr/agent-runs.md).
      ["Now", "/agents/now"],
      ["Connect an agent", "/agents/connect"],
    ];
  }
  const owning = links
    .filter(([, href]) => path === href || path.startsWith(`${href}/`))
    .sort((a, b) => b[1].length - a[1].length)[0]?.[1];
  return {
    label,
    items: links.map(([label, href]) => ({
      label,
      href,
      active: href === owning,
    })),
  };
}

const AGENT_GROUPS: readonly {
  label: string;
  sections: readonly AgentSection[];
}[] = [
  { label: "Overview", sections: ["overview"] },
  { label: "Resources", sections: ["connectors", "vault", "skills", "memory"] },
  { label: "Controls", sections: ["spending", "rules", "settings"] },
  { label: "Activity", sections: ["activity"] },
];
export function agentNavigation(id: string, section: AgentSection) {
  const group = AGENT_GROUPS.find((g) => g.sections.includes(section))!;
  const href = (key: AgentSection) =>
    `/agents/${encodeURIComponent(id)}?section=${key}`;
  return {
    primary: AGENT_GROUPS.map((g) => ({
      label: g.label,
      href: href(g === group ? section : g.sections[0]!),
      active: g === group,
    })),
    secondary:
      group.sections.length > 1
        ? group.sections.map((key) => ({
            label: AGENT_SECTIONS.find(([value]) => value === key)![1],
            href: href(key),
            active: key === section,
          }))
        : [],
  };
}
