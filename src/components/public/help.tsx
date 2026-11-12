import { AGENT_PLATFORMS as PLATFORMS } from "@/domain/agents/compatibility";
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
export function Help({ connectorAddress }: { connectorAddress: string }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-6">
        <Wordmark href="/" />
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Connect your agents to Warthog
        </h1>
        <p className="max-w-prose text-base text-fg-muted">
          Warthog manages each compatible agent’s access to your resources. It observes and controls actions routed through Warthog; it cannot control tools an agent uses directly elsewhere.
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
              <dd className="text-sm text-fg-muted">{platform.steps.join(" ")}{"docs" in platform ? <> <a href={platform.docs} className="text-accent underline">Provider setup guide</a></> : null}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">If an agent can&#39;t connect yet</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Some agents don&#39;t yet support remote connections. An access key works only when a client supports remote connections using an access key; it cannot add missing connection support. Connecting a service such as Slack or Notion as a tool does not register that service’s own agents.
        </p>
      </section>
    <section id="connector-verification" className="mt-8 flex flex-col gap-3 border-t border-line pt-6">
        <h2 className="text-xl font-semibold">Connector verification</h2>
        <p>Catalogue availability means setup is supported by the configured integration. It does not certify that every provider operation has passed a live test.</p>
        <p>Configured means an integration definition exists. Protocol tested locally means its request and response handling has automated tests using simulated services. Live verified names the specific operations tested against a connected account and their date.</p>
        <p>Claude through Warthog to Gmail has verified live context, search and message reads as of 12 November 2026. Sending, renewal and revocation require their own acceptance evidence. Other catalogue entries have no published live verification record yet.</p>
        <p>Warthog governs requests made through its connection. It does not receive your agent’s private conversations, model reasoning, model usage charges or activity in separate tools. Connected means access is authorised, not that a worker is running.</p>
        <p>General-purpose tools may not identify their message type or recipient. Applicable restrictions are enforced conservatively; a provider’s tool description cannot override your rules.</p>
      </section>
      </main>
  );
}
