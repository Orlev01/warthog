export const AGENT_SECTIONS = [
  ["overview", "Overview"],
  ["connectors", "Connectors"],
  ["vault", "Vault"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["spending", "Spending"],
  ["rules", "Rules"],
  ["activity", "Activity"],
  ["settings", "Settings"],
] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number][0];
export type PermissionsSection = AgentSection | "all";
export function agentSection(value: unknown): AgentSection | null {
  if (value === undefined) return "overview";
  return AGENT_SECTIONS.some(([key]) => key === value)
    ? (value as AgentSection)
    : null;
}

// The names an account's controls carry on an agent's Connectors section, keyed by the
// account's (connection's) id, so several accounts of one service each have their own
// (docs/adr/several-accounts-per-agent.md). The row renders them and the save reads them back
// by these names, never by visible text. A tool checkbox's value is `<connector>__<verb>`.
export const ACCOUNT_CONTROL = {
  granted: (accountId: string) => `account:${accountId}`,
  read: (accountId: string) => `accountRead:${accountId}`,
  change: (accountId: string) => `accountChange:${accountId}`,
  toolScope: (accountId: string) => `accountToolScope:${accountId}`,
  tool: (accountId: string) => `accountTool:${accountId}`,
} as const;
