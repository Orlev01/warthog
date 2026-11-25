// Which brand mark identifies a connected service or an agent platform
// (docs/adr/brand-marks-and-accent.md). Services resolve by their catalogue id; agents by
// their platform label, then their name ("Claude on my laptop" is still Claude). An unknown
// brand resolves to nothing, and the caller shows a neutral initial — never a guessed logo.
//
// Pure: no React, no I/O.

import { BRAND_MARKS } from "./brand-registry";

export type BrandMarkRef = { readonly title: string; readonly src: string };

export function serviceBrand(connectorId: string | undefined): BrandMarkRef | undefined {
  return connectorId === undefined ? undefined : BRAND_MARKS[connectorId];
}

// Platform keywords, most specific first. Each maps to an `agent-<key>` registry entry.
const AGENT_KEYWORDS: readonly (readonly [RegExp, string])[] = [
  [/\bclaude\b|anthropic/i, "claude"],
  [/chat\s?gpt|openai|\bdots\b|\bcodex\b/i, "chatgpt"],
  [/gemini|\bbard\b/i, "gemini"],
  [/\bgrok\b/i, "grok"],
  [/notion/i, "notion"],
  [/llama|\bmeta\b/i, "llama"],
  [/perplexity/i, "perplexity"],
  [/cursor/i, "cursor"],
  [/copilot/i, "copilot"],
  [/mistral|le chat/i, "mistral"],
];

export function agentBrand(platform: string | undefined, name?: string): BrandMarkRef | undefined {
  for (const text of [platform, name]) {
    if (!text) continue;
    const match = AGENT_KEYWORDS.find(([pattern]) => pattern.test(text));
    if (match) return BRAND_MARKS[`agent-${match[1]}`];
  }
  return undefined;
}

// The provider an agent's mark belongs to, in words, for grouping agents by maker (the Now
// view). The same keywords as the mark, so a group always matches the marks in it.
export type AgentProvider = { readonly key: string; readonly label: string };

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
  notion: "Notion",
  llama: "Llama",
  perplexity: "Perplexity",
  cursor: "Cursor",
  copilot: "Copilot",
  mistral: "Mistral",
};

/** The agent's provider by its platform, then its name; "other" when neither names one. */
export function agentProvider(platform: string | undefined, name?: string): AgentProvider {
  for (const text of [platform, name]) {
    if (!text) continue;
    const match = AGENT_KEYWORDS.find(([pattern]) => pattern.test(text));
    if (match) return { key: match[1], label: PROVIDER_LABELS[match[1]] ?? match[1] };
  }
  return { key: "other", label: "Other agents" };
}

/** The letter a neutral tile shows for a brand without a mark. */
export function brandInitial(name: string): string {
  const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0];
  return letter ? letter.toUpperCase() : "?";
}
