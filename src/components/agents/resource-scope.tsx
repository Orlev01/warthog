"use client";
import * as React from "react";
import { Select } from "@/components/ui/select";

const RESOURCES: Record<string, { section: string; description: string }> = {
  connectors: {
    section: "connectors",
    description:
      "Service accounts belong to you. Choose an agent to grant access or select which service account it uses.",
  },
  vault: {
    section: "vault",
    description:
      "Your vault belongs to you. Each agent has separate identity and card request permissions; sensitive releases always need approval.",
  },
  skills: {
    section: "skills",
    description:
      "This is your shared skills library. Each skill has a default audience; individual agents can have their own assignments.",
  },
  memory: {
    section: "memory",
    description:
      "This is all your memory. Shared memories are readable by permitted agents; private memories stay with their source agent.",
  },
  spending: {
    section: "spending",
    description:
      "This is spending across your agents. Choose one to manage its budget and card access.",
  },
  rules: {
    section: "rules",
    description:
      "Rules can apply globally or to a chosen agent. Global restrictions still apply when you customise an agent.",
  },
};
export type ScopeAgent = { id: string; name: string };
export function ResourceScope({
  pathname,
  agents,
}: {
  pathname: string;
  agents: readonly ScopeAgent[];
}) {
  const key = pathname.split("/")[1] ?? "";
  const resource = RESOURCES[key];
  if (!resource) return null;
  return (
    <aside aria-label="Resource scope" className="wh-resource-scope">
      <div className="wh-resource-scope-inner">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4">
          <p className="text-sm font-medium">Account resources</p>
          <details className="text-xs text-fg-muted">
            <summary className="inline-flex min-h-11 cursor-pointer items-center underline decoration-line-strong underline-offset-4 sm:min-h-8">
              How access works
            </summary>
            <p className="max-w-xl pb-2 text-sm leading-relaxed">
              {resource.description}
            </p>
          </details>
        </div>
        {agents.length ? (
          <label className="flex min-w-0 w-full flex-col gap-1.5 text-xs text-fg-muted sm:w-64">
            Manage for an agent
            <Select
              value=""
              onChange={(event) => {
                if (event.target.value)
                  window.location.assign(
                    `/agents/${encodeURIComponent(event.target.value)}?section=${resource.section}`,
                  );
              }}
            >
              <option value="">Choose an agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          <a
            href="/agents/connect"
            className="inline-flex min-h-11 items-center text-sm font-medium text-accent underline underline-offset-4"
          >
            Connect your first agent
          </a>
        )}
      </div>
    </aside>
  );
}
