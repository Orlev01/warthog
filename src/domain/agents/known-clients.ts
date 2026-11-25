// The MCP client names Warthog has measured, and the product and provider each belongs to
// (docs/adr/agent-names-and-providers.md). Pure: no I/O.
//
// An app names itself in its MCP client info ("gemini-cli-mcp-client"). That name is the
// app's own claim, so it never changes an agent's platform, which Warthog records from the
// connection itself. It only lets a screen say what the app reported in words a person
// recognises ("Gemini CLI") and which provider's agents it sits with.
//
// A name is listed only after it was seen from the real app, with when and how. A name that
// isn't listed is shown as reported.

// The provider key matches the agent marks' keys (src/domain/brands.ts), so an agent that
// reports a Gemini app sits with the other Gemini agents.
export type ClientProvider = "claude" | "chatgpt" | "gemini";

export interface KnownClient {
  // The client name exactly as the app sends it.
  readonly name: string;
  // The product in the words its maker uses.
  readonly product: string;
  readonly provider: ClientProvider;
  // When the name was seen from the real app, and how.
  readonly measured: string;
  readonly source: string;
}

export const KNOWN_CLIENTS: readonly KnownClient[] = [
  {
    name: "claude-code",
    product: "Claude Code",
    provider: "claude",
    measured: "2026-11-16",
    source: "Claude Code 2.1.289 directly and through the claude.ai connector, and claude.ai's Cowork sessions (docs/adr/agent-runs.md)",
  },
  {
    name: "Anthropic/ClaudeAI",
    product: "claude.ai",
    provider: "claude",
    measured: "2026-11-16",
    source: "claude.ai's own connector checks through the claude.ai connector (docs/adr/agent-runs.md)",
  },
  {
    name: "Anthropic/Toolbox",
    product: "claude.ai",
    provider: "claude",
    measured: "2026-11-16",
    source: "claude.ai's own connector checks through the claude.ai connector (docs/adr/agent-runs.md)",
  },
  {
    name: "codex-mcp-client",
    product: "Codex",
    provider: "chatgpt",
    measured: "2026-11-25",
    source: "Codex CLI 0.170.0 starting a session against a recording MCP server (title \"Codex\")",
  },
  {
    name: "gemini-cli-mcp-client",
    product: "Gemini CLI",
    provider: "gemini",
    measured: "2026-11-25",
    source: "Gemini CLI 0.46.0 starting a session against a recording MCP server",
  },
];

const BY_NAME: ReadonlyMap<string, KnownClient> = new Map(KNOWN_CLIENTS.map((client) => [client.name, client]));

/** The measured app a client name belongs to, or undefined for a name not yet measured. */
export function knownClient(name: string | undefined): KnownClient | undefined {
  return name === undefined ? undefined : BY_NAME.get(name.trim());
}

// What an agent's apps say they are, in one phrase: the product when every app it came
// through that Warthog knows is the same product ("Gemini CLI"), otherwise their shared
// provider. Never identity.
export interface ReportedApp {
  readonly provider: ClientProvider;
  readonly label: string;
}

/**
 * What an agent's recent apps reported, when the ones Warthog knows agree on a provider.
 * Apps it doesn't know are left out; apps from different providers give nothing, since the
 * agent's credential is then being used from more than one maker's app.
 */
export function reportedApp(apps: readonly { name?: string }[]): ReportedApp | null {
  const known = apps.map((app) => knownClient(app.name)).filter((client): client is KnownClient => client !== undefined);
  const first = known[0];
  if (!first) return null;
  if (known.some((client) => client.provider !== first.provider)) return null;
  const sameProduct = known.every((client) => client.product === first.product);
  return { provider: first.provider, label: sameProduct ? first.product : PROVIDER_NAMES[first.provider] };
}

const PROVIDER_NAMES: Readonly<Record<ClientProvider, string>> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
};
