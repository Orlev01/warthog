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

/** The letter a neutral tile shows for a brand without a mark. */
export function brandInitial(name: string): string {
  const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0];
  return letter ? letter.toUpperCase() : "?";
}
