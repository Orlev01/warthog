import * as React from "react";

import { Wordmark } from "../shell/wordmark";

// Help — the public help / compatibility VIEW (brief feature "Agent compatibility
// and help pages"; "Connect an agent"). From ONE render-testable component it shows,
// per agent platform, how to connect Warthog, where to paste Warthog's connector
// address, and a note of any current platform gap and what to do instead.
//
// The connector address is config-driven (INV-21), so it arrives as a prop — the
// page entry (src/app/help/compatibility/page.tsx) derives it from
// `config.publicBaseUrl` and passes it in; this component stays pure (no config, no
// DB). Everything is said in plain Australian English — no protocol or security
// jargon reaches a primary screen (brief design_ux.copy). Colour, spacing and radius
// come from the design tokens (globals.css) — never a raw hex value.

// The six agent platforms the task/brief name, each with plain connect steps. The
// steps say exactly where to paste the Warthog address shown above them.
const PLATFORMS: { name: string; steps: string }[] = [
  {
    name: "Claude",
    steps:
      "Open Settings, then Connectors. Choose Add custom connector, paste your Warthog address, then sign in and approve what Claude may do.",
  },
  {
    name: "ChatGPT",
    steps:
      "Open Settings, then Connectors. Add a custom connector, paste your Warthog address, and sign in to approve it.",
  },
  {
    name: "Gemini",
    steps:
      "In the connections or extensions settings, add a custom connector, paste your Warthog address, and sign in to approve it.",
  },
  {
    name: "Grok",
    steps:
      "In the connections settings, add a custom connector, paste your Warthog address, and sign in to approve it.",
  },
  {
    name: "Llama",
    steps:
      "For Llama-based clients that support custom connectors, add one and paste your Warthog address, then sign in to approve it.",
  },
  {
    name: "Other",
    steps:
      "Any agent that supports a custom connector can connect: add a new connector, paste your Warthog address, and sign in to approve it.",
  },
];

export function Help({ connectorAddress }: { connectorAddress: string }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-6">
        <Wordmark href="/" />
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Connect your agents to Warthog
        </h1>
        <p className="max-w-prose text-base text-fg-muted">
          Warthog works with the agents you already use. Add your Warthog address to
          each agent below and it connects straight to your home — never with your own
          logins.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Your Warthog address</h2>
        <p className="text-sm text-fg-muted">
          Copy this address and paste it in when your agent asks for a custom
          connector.
        </p>
        <code className="block overflow-x-auto rounded-card border border-line bg-surface-muted px-3 py-2 font-mono text-sm text-fg">
          {connectorAddress}
        </code>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Connect each agent</h2>
        <dl className="flex flex-col gap-3">
          {PLATFORMS.map((platform) => (
            <div
              key={platform.name}
              className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4"
            >
              <dt className="font-medium text-fg">{platform.name}</dt>
              <dd className="text-sm text-fg-muted">{platform.steps}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">If an agent can&#39;t connect yet</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Some agents don&#39;t yet support adding a custom connector. For those,
          create an access key in Warthog and paste that into the agent instead.
        </p>
      </section>
    </main>
  );
}
