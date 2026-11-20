// What Warthog knows about each tool's effect, for the audit log: which tools only read
// (so an entry can be counted as a read rather than a change) and which curated tools
// declare a reversal (so the Activity page offers Undo exactly where the undo service can
// act). One index, built from the published MCP effect metadata and the curated connector
// definitions, so the audit log, the MCP hints and the routing can never disagree.
//
// A tool missing from the read-only set is treated as a change — a `<service>__request`
// call, a provider-hosted MCP tool and any unknown name included — because its effect
// cannot be confirmed from the plaintext record.

import { CORE_READ_ONLY_TOOLS } from "../mcp/tools/metadata";
import { GOOGLE_CURATED_TOOLS } from "../connectors/curated/google";
import { MICROSOFT_CURATED_TOOLS } from "../connectors/curated/microsoft";
import { LINKEDIN_CURATED_TOOLS } from "../connectors/curated/linkedin";

const CURATED = [...GOOGLE_CURATED_TOOLS, ...MICROSOFT_CURATED_TOOLS, ...LINKEDIN_CURATED_TOOLS];

export const READ_ONLY_TOOLS: readonly string[] = [
  ...CORE_READ_ONLY_TOOLS,
  ...CURATED.filter((tool) => !tool.makesChange).map((tool) => tool.name),
];

const READ_ONLY = new Set(READ_ONLY_TOOLS);

export function isReadOnlyTool(tool: string): boolean {
  return READ_ONLY.has(tool);
}

const REVERSALS: ReadonlyMap<string, string> = new Map(
  CURATED.flatMap((tool) => (tool.reversalTool ? [[tool.name, tool.reversalTool] as const] : [])),
);

// The curated tool that undoes `tool`, or undefined when none is declared.
export function reversalToolFor(tool?: string): string | undefined {
  return tool === undefined ? undefined : REVERSALS.get(tool);
}
