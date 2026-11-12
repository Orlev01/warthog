// The agent's platform in words a member recognises (content-53, newcomer-17). The stored
// platform is whatever the connection recorded: a client's own name from the consent screen
// ("Claude", "Claude Desktop"), the access-key page's choice ("Other", "Grok"), or an
// internal slug ("dev-console"). A known name is shown in its usual spelling, a slug is put
// into words, and a placeholder that says nothing ("Other") is left out — never the raw key.
// Pure: no React, no I/O.

const KNOWN: Readonly<Record<string, string>> = {
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
  "dev-console": "Developer console",
};

const PLACEHOLDERS = new Set(["other", "unknown", "none", "n/a"]);

/** The platform label to show, or null when there is nothing worth showing. */
export function platformLabel(platform: string | null | undefined): string | null {
  const raw = (platform ?? "").trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (PLACEHOLDERS.has(key)) return null;
  const known = KNOWN[key];
  if (known) return known;
  // A machine key ("my-client", "home_assistant") reads as words: "My client".
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(raw)) {
    const words = raw.replace(/[-_]+/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return raw;
}
