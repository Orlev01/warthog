import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// The account-level scope for resource pages (Connectors, Vault, Skills, Memory, Spending,
// Rules): these pages show everything on the member's account, and each agent's own access is
// managed inside that agent's workspace. The row offers two disclosures:
//   • "How access works" — what the account view means for this resource;
//   • "Manage for one agent" — a link per agent to that agent's matching section.
// Links rather than a select that navigates on change (WCAG 3.2.2: an arrow key must not leave
// the page), so it works without JavaScript and every destination is a real URL.
//
// Two placements share this markup: inside the page's WorkspaceHeading band (`heading`, the
// default once a page uses WorkspaceHeading — it reads the agents from WorkspaceContext), and
// a fallback strip above pages that don't yet (`strip`, rendered by PortalChrome and hidden by
// CSS whenever the heading carries the scope). With no agents connected the picker is left out
// rather than replaced by a competing "Connect your first agent" call to action.

const RESOURCES: Record<string, { section: string; noun: string; description: string }> = {
  connectors: {
    section: "connectors",
    noun: "connectors",
    description:
      "Service accounts belong to you. Choose an agent to grant access or select which service account it uses.",
  },
  vault: {
    section: "vault",
    noun: "vault access",
    description:
      "Your vault belongs to you. Each agent has separate identity and card request permissions; sensitive releases always need approval.",
  },
  skills: {
    section: "skills",
    noun: "skills",
    description:
      "This is your shared skills library. Each skill has a default audience; individual agents can have their own assignments.",
  },
  memory: {
    section: "memory",
    noun: "memory",
    description:
      "This is all your memory. Shared memories are readable by permitted agents; private memories stay with their source agent.",
  },
  spending: {
    section: "spending",
    noun: "spending",
    description:
      "This is spending across your agents. Choose one to manage its budget and card access.",
  },
  rules: {
    section: "rules",
    noun: "rules",
    description:
      "Rules can apply to all agents or to a chosen one. Your rules for all agents still apply when you customise one.",
  },
};
// `connected: false` marks a disconnected agent. It is left out of "Manage for one agent":
// its settings are read-only and it can't use the resource; its history stays on its own page.
export type ScopeAgent = { id: string; name: string; connected?: boolean };

export function resourceScopeFor(pathname: string) {
  return RESOURCES[pathname.split("/")[1] ?? ""] ?? null;
}

export function ResourceScope({
  pathname,
  agents,
  variant = "strip",
}: {
  pathname: string;
  agents: readonly ScopeAgent[];
  variant?: "strip" | "heading";
}) {
  const resource = resourceScopeFor(pathname);
  if (!resource) return null;
  const manageable = agents.filter((agent) => agent.connected !== false);
  const row = (
    <>
      <details className="wh-scope-disclosure">
        <summary>
          How access works
          <ChevronDown aria-hidden size={14} className="wh-scope-chevron" />
        </summary>
        <p>{resource.description}</p>
      </details>
      {manageable.length ? (
        <details className="wh-scope-disclosure">
          <summary>
            Manage for one agent
            <ChevronDown aria-hidden size={14} className="wh-scope-chevron" />
          </summary>
          <ul role="list" aria-label={`Manage ${resource.noun} for one agent`} className="wh-scope-agents">
            {manageable.map((agent) => (
              <li key={agent.id}>
                <a href={`/agents/${encodeURIComponent(agent.id)}?section=${resource.section}`}>
                  <span>{agent.name}</span>
                  <ChevronRight aria-hidden size={16} />
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
  return variant === "heading" ? (
    <div role="group" aria-label="Agent scope" className="wh-heading-scope wh-scope">
      {row}
    </div>
  ) : (
    <aside aria-label="Agent scope" className="wh-resource-scope">
      <div className="wh-resource-scope-inner wh-scope">{row}</div>
    </aside>
  );
}
