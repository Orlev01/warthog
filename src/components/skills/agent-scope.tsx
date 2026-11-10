"use client";
import * as React from "react";
import { Label } from "@/components/ui/field";
export interface SkillAgent { id: string; displayName: string; status?: string }
export const SKILL_CONTROL = "min-h-11 w-full min-w-0 rounded-card border border-line-input bg-surface px-3 py-2 text-base sm:text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function AgentScope({ agents, scope: initial = "all", selected = [] }: { agents: readonly SkillAgent[]; scope?: "all" | "chosen"; selected?: readonly string[] }) {
  const id = React.useId();
  const [scope, setScope] = React.useState(initial);
  return <fieldset className="min-w-0 space-y-3">
    <legend className="mb-2 text-sm font-medium">Which agents</legend>
    <p className="text-sm text-fg-muted">These are the effective assignments, including changes made in agent workspaces. Saving replaces this skill’s previous assignments.</p>
    <Label htmlFor={id} className="sr-only">Skill access</Label>
    <select id={id} name="scope" value={scope} onChange={(e) => setScope(e.target.value as "all" | "chosen")} className={SKILL_CONTROL}>
      <option value="all">All agents</option><option value="chosen">Chosen agents</option>
    </select>
    {scope === "chosen" && <div className="space-y-1">
      {agents.filter((a) => a.status !== "disconnected").map((a) => <label key={a.id} className="flex min-h-11 items-center gap-3 text-sm [overflow-wrap:anywhere]">
        <input type="checkbox" name="scopedAgentIds" value={a.id} defaultChecked={selected.includes(a.id)} className="h-4 w-4 shrink-0 accent-accent" />{a.displayName}
      </label>)}
      <p className="text-sm text-fg-muted">Only selected agents can use this skill. With none selected, it stays private.</p>
      {!agents.some((a) => a.status !== "disconnected") && <p className="text-sm text-fg-muted">Connect an agent to choose it here.</p>}
    </div>}
  </fieldset>;
}
