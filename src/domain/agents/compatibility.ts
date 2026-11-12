// Provider-documented connection paths reviewed 2026-11-11. This is capability
// guidance, not a claim that every provider has passed a live Warthog test.
//
// `status` is the one-line answer a member looks for first ("will this work for me?"),
// in plain words; the steps follow. "unverified" marks a platform Warthog has found no
// documented way to connect yet: the connect guide lists it apart, with a "Not verified
// yet" badge, rather than among the platforms that work. `featured` platforms are the
// common ones the connect guide shows first. Steps never promise more than the provider
// documents (content-08).
export type PlatformStatus = "connector" | "depends" | "unverified";

export const AGENT_PLATFORMS = [
  {
    name: "Claude",
    status: "connector",
    featured: true,
    summary: "Add Warthog as a custom connector.",
    steps: [
      "Open Settings, then Connectors, and add a custom connector.",
      "Paste your Warthog address, sign in and review the permissions for this agent.",
    ],
    docs: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  },
  {
    name: "ChatGPT",
    status: "connector",
    featured: true,
    summary: "Add Warthog as a custom app, where your plan allows it.",
    steps: [
      "Use the custom app setup available to your account or workspace. Your administrator may need to enable it.",
      "Paste your Warthog address and complete sign-in. Review the agent’s permissions before connecting.",
    ],
    docs: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
  },
  {
    name: "Notion Custom Agents",
    status: "connector",
    summary: "Add Warthog as a custom connection for each agent.",
    steps: [
      "Open the Custom Agent’s settings and add a custom connection.",
      "Enter your Warthog address and authenticate for that agent. Grant only the tools it needs.",
    ],
    docs: "https://www.notion.com/help/mcp-connections-for-custom-agents",
  },
  {
    name: "Gemini",
    status: "depends",
    summary: "Works in Gemini CLI.",
    steps: [
      "In Gemini CLI, add a remote server using your Warthog address, then sign in to Warthog.",
      "The Gemini app may not let you add custom connections yet. Check its settings before you start.",
    ],
    docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md",
  },
  {
    name: "Grok",
    status: "depends",
    summary: "Works with agents built on the xAI API.",
    steps: [
      "For an agent built on the xAI API, add a remote tool using your Warthog address.",
      "If it asks for an access key instead, create one for that agent in Warthog. The Grok app may not let you add custom connections yet.",
    ],
    docs: "https://docs.x.ai/developers/tools/remote-mcp",
  },
  {
    name: "Llama-based clients",
    status: "depends",
    summary: "Depends on the app you use.",
    steps: [
      "Check that your app can add a remote custom connection.",
      "Sign in to Warthog when it asks. Create an access key only if the app asks for one.",
    ],
  },
  {
    name: "Dots (OpenAI)",
    status: "unverified",
    summary: "No documented way to connect yet.",
    steps: [
      "Open your dot’s profile and review Customize → Plugins. Available apps use your shared ChatGPT settings.",
      "OpenAI documents supported connected apps, but Warthog has not verified a direct custom connection for Dots. Do not create an access key unless a documented private credential field requests one.",
    ],
    docs: "https://help.openai.com/en/articles/20001530-getting-started-with-your-dot",
  },
  {
    name: "Instinct",
    status: "unverified",
    summary: "No documented way to connect yet.",
    steps: [
      "Instinct’s public site describes a text and phone assistant, without a published custom connection setup.",
      "A direct Warthog connection is unverified. Check your account for a documented custom connection before attempting setup.",
    ],
    docs: "https://instinct.com/",
  },
  {
    name: "Other",
    status: "depends",
    summary: "Depends on the app you use.",
    steps: [
      "For Slack-based agents or another tool, check the app supports a remote custom connection before setting it up.",
      "Use a separate Warthog connection for each agent you want to control independently. An app that can’t add a remote connection can’t use Warthog, and an access key doesn’t change that.",
    ],
  },
] as const satisfies readonly {
  name: string;
  status: PlatformStatus;
  featured?: boolean;
  summary: string;
  steps: readonly string[];
  docs?: string;
}[];
