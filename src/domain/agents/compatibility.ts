// Provider-documented connection paths reviewed 2026-11-11. This is capability
// guidance, not a claim that every provider has passed a live Warthog test.
export const AGENT_PLATFORMS = [
  {
    name: "Claude",
    steps: [
      "Open Settings, then Connectors, and add a custom connector.",
      "Paste your Warthog address, sign in and review the permissions for this agent.",
    ],
    docs: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  },
  {
    name: "ChatGPT",
    steps: [
      "Use the custom app setup available to your account or workspace. Your administrator may need to enable it.",
      "Paste your Warthog address and complete sign-in. Review the agent’s permissions before connecting.",
    ],
    docs: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
  },
  {
    name: "Notion Custom Agents",
    steps: [
      "Open the Custom Agent’s settings and add a custom connection.",
      "Enter your Warthog address and authenticate for that agent. Grant only the tools it needs.",
    ],
    docs: "https://www.notion.com/help/mcp-connections-for-custom-agents",
  },
  {
    name: "Gemini",
    steps: [
      "For Gemini CLI, configure a remote server connection using your Warthog address and complete sign-in.",
      "Other Gemini products have their own capabilities; do not assume the consumer chat app can add this connection.",
    ],
    docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md",
  },
  {
    name: "Grok",
    steps: [
      "For an xAI API agent, configure a remote tool using your Warthog address.",
      "If the client accepts an access key, create an access key for that agent. This does not imply support in the consumer Grok app.",
    ],
    docs: "https://docs.x.ai/developers/tools/remote-mcp",
  },
  {
    name: "Llama-based clients",
    steps: [
      "Check that the particular client supports remote custom connections.",
      "Use sign-in where available. Create an access key only if the client asks for one.",
    ],
  },
  {
    name: "Dots (OpenAI)",
    steps: [
      "Open your dot’s profile and review Customize → Plugins. Available apps use your shared ChatGPT settings.",
      "OpenAI documents supported connected apps, but Warthog has not verified a direct custom connection for Dots. Do not create an access key unless a documented private credential field requests one.",
    ],
    docs: "https://help.openai.com/en/articles/20001530-getting-started-with-your-dot",
  },
  {
    name: "Instinct",
    steps: [
      "Instinct’s public site describes a text and phone assistant, without a published custom connection setup.",
      "A direct Warthog connection is unverified. Check your account for a documented custom connection before attempting setup.",
    ],
    docs: "https://instinct.com/",
  },
  {
    name: "Other",
    steps: [
      "For Slack-based agents or another tool, verify the specific client supports a remote custom connection before setting it up.",
      "Use a separate Warthog connection for each agent you want to control independently. A client that does not support remote connections cannot use Warthog; creating a key does not change that.",
    ],
  },
] as const;
