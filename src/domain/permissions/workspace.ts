export const AGENT_SECTIONS = [
  ["overview", "Overview"],
  ["connectors", "Connectors"],
  ["vault", "Vault"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["spending", "Spending"],
  ["rules", "Rules"],
  ["activity", "Audit log"],
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
