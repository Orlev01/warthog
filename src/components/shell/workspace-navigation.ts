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
export const NAV_GROUPS: readonly {
  label: string;
  items: readonly NavNode[];
}[] = [
  { label: "Workspace", items: ["home", "agents", "inbox"].map(item) },
  {
    label: "Account resources",
    items: ["connectors", "vault", "skills", "memory", "life-admin"].map(item),
  },
  { label: "Insights", items: ["activity", "spending"].map(item) },
  { label: "Manage", items: ["rules", "household", "settings"].map(item) },
  { label: "Resources", items: ["help"].map(item) },
];

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
      ["Identity", "/vault"],
      ["Cards", "/vault/cards"],
    ];
  } else if (section === "memory" || section === "skills") {
    label = "Knowledge";
    links = [
      ["Memory", "/memory"],
      ["Skills & plugins", "/skills"],
    ];
  } else if (section === "activity" || section === "spending") {
    label = "Insights";
    links = [
      ["Activity", "/activity"],
      ["Spending", "/spending"],
    ];
  } else if (path === "/agents" || path === "/agents/connect") {
    label = "Agents";
    links = [
      ["Your agents", "/agents"],
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
  { label: "Audit log", sections: ["activity"] },
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
