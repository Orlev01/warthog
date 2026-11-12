// How the Rules page organises its list: its in-page views, its status filter and the
// grouping of rules by scope. A plain module (no "use client"), so the server page, the
// rules actions and the client view all read the same keys — a value exported from a
// client module would reach server code only as a client reference.

import type { RuleDisplayLabels, RuleKind, RuleScope } from "@/domain/rules/rules";
import { hrefWith } from "@/lib/href";

export const RULES_PATH = "/rules";

// The in-page views, in tab order. "rules" is the default and never written to the URL.
export const RULES_VIEWS = ["rules", "new", "budgets"] as const;
export type RulesViewKey = (typeof RULES_VIEWS)[number];

// The status filter values (`?status=`); no value means every rule.
export const RULE_STATUS_FILTERS = ["active", "paused"] as const;
export type RuleStatusFilter = (typeof RULE_STATUS_FILTERS)[number];

export const RULE_STATUS_LABELS: Record<RuleStatusFilter, string> = {
  active: "Active",
  paused: "Paused",
};

// The rules list filtered to one status, or every rule. Only the fixed path is emitted.
export function rulesStatusHref(status: RuleStatusFilter | undefined): string {
  return hrefWith(RULES_PATH, {}, { status });
}

// One tool or service a rule may name: `value` is the exact name the engine matches (and
// the form posts); `label` is its plain name. Grouped for the builder's <optgroup>s.
export type RuleTargetChoice = { value: string; label: string };
export type RuleTargetGroup = { label: string; choices: RuleTargetChoice[] };

// The display labels a set of builder choices gives: each tool by its choice label (its
// title) and each service by its catalogue name. The builder's preview and the Rules page
// list both name tools and services through this, from the same choices, so the preview
// reads exactly what the saved rule reads. An id outside the choices resolves to nothing
// (the sentence then shows the id).
export function ruleLabelsFromChoices(
  tools: ReadonlyArray<RuleTargetGroup> | undefined,
  services: ReadonlyArray<RuleTargetGroup> | undefined,
): RuleDisplayLabels {
  const index = (groups: ReadonlyArray<RuleTargetGroup> | undefined) =>
    new Map((groups ?? []).flatMap((group) => group.choices.map((choice) => [choice.value, choice.label] as const)));
  const toolLabels = index(tools);
  const serviceLabels = index(services);
  return { toolTitle: (tool) => toolLabels.get(tool), serviceName: (service) => serviceLabels.get(service) };
}

// The part of a rule the grouping reads.
export type GroupableRule = {
  readonly scope: RuleScope;
  readonly status: "active" | "paused";
  readonly kind: RuleKind;
};

export type RuleGroup<R extends GroupableRule> = {
  // "all" for the all-agents group; otherwise the chosen agent's connection id.
  readonly key: string;
  readonly title: string;
  readonly agentId: string | null;
  readonly rules: R[];
};

const STATUS_ORDER = { active: 0, paused: 1 } as const;
const KIND_ORDER = { ask_first: 0, never_allow: 1 } as const;

// Rules grouped by scope: the all-agents group first, then one group per chosen agent by
// name (case-insensitive; same-named agents by id). Within a group, active before paused
// and ask-first before never-allow; otherwise the given order is kept. Empty groups are
// never produced.
export function groupRulesByScope<R extends GroupableRule>(rules: readonly R[]): RuleGroup<R>[] {
  const byKey = new Map<string, { title: string; agentId: string | null; rules: R[] }>();
  for (const rule of rules) {
    const key = rule.scope.type === "agent" ? rule.scope.agentId : "all";
    let group = byKey.get(key);
    if (!group) {
      group =
        rule.scope.type === "agent"
          ? { title: rule.scope.name, agentId: rule.scope.agentId, rules: [] }
          : { title: "All agents", agentId: null, rules: [] };
      byKey.set(key, group);
    }
    group.rules.push(rule);
  }
  const groups = [...byKey.entries()].map(([key, group]) => ({
    key,
    ...group,
    rules: [...group.rules].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
    ),
  }));
  return groups.sort((a, b) => {
    if (a.agentId === null || b.agentId === null) return a.agentId === null ? (b.agentId === null ? 0 : -1) : 1;
    return (
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
    );
  });
}
