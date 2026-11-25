// The product a request came through — "via Claude Code" — as the client reported it
// (docs/adr/agent-runs.md). Pure: no I/O.
//
// Requests relayed by Anthropic's connector service carry an `x-anthropic-client` header
// naming the product (observed 16 Nov 2026: `ClaudeCode` for Claude Code, `Cowork` for
// claude.ai sessions, `ClaudeAI` for claude.ai's own connector checks). A client that
// connects directly sends no such header, so its MCP client name is used instead (Claude
// Code reports `claude-code`, Gemini CLI `gemini-cli-mcp-client`): a measured name reads as
// its product (`known-clients.ts`), any other as reported. Either is a client claim, shown as
// such — never identity.

import { redact } from "../redaction/redact";
import { knownClient } from "./known-clients";

const ANTHROPIC_PRODUCTS: Readonly<Record<string, string>> = {
  ClaudeCode: "Claude Code",
  Cowork: "Claude Cowork",
  ClaudeAI: "claude.ai",
};

// A short, printable product name. Anything else is not shown rather than cleaned up.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,59}$/;

export const ANTHROPIC_CLIENT_HEADER = "x-anthropic-client";

/**
 * The product a request came through, or undefined when the client named none. An unknown
 * name is shown as reported, after redaction: it is stored as plain metadata, so a card
 * number or other secret a client puts there never lands in clear.
 */
export function clientSurface(anthropicClient: string | null | undefined, clientName?: string): string | undefined {
  const header = anthropicClient?.trim();
  if (header && SAFE.test(header)) return ANTHROPIC_PRODUCTS[header] ?? reported(header);
  const name = clientName?.trim();
  if (name && SAFE.test(name)) return knownClient(name)?.product ?? reported(name);
  return undefined;
}

function reported(value: string): string {
  return String(redact(value, () => false));
}
