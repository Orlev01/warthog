"use client";

import * as React from "react";

import { CopyButton } from "@/components/ui/copy-button";

// E10-S04 — Guided connect view per platform (brief "Connect an agent").
//
// A signed-in person on the Agents area needs plain, per-platform steps for pasting
// Warthog's connector address into each AI client, a button to copy that address, and
// — where a platform cannot yet use a remote connector — a note of that gap and what to
// do instead. From ONE render-testable component it shows, for Claude, ChatGPT, Gemini,
// Grok, Llama-based clients and "Other":
//   • Warthog's connector address, shown to paste, with a COPY control, and
//   • ORDERED steps telling the person exactly where to paste it, and
//   • any current platform GAP together with what to do instead.
//
// The connector address is config-driven (INV-21 / constitution #21: the public address
// is read from configuration — the public base URL — never hard-coded in a component).
// src/components/** is PURE (no config, no DB), so it arrives as a PROP: the page/entry
// that mounts this view derives it from `config.publicBaseUrl` and passes it in, exactly
// as the sibling public Help view takes `connectorAddress`. The view DISPLAYS whatever
// address it is given (so swapping the config value swaps what the screen shows and what
// Copy copies) and bakes no address in.
//
// This whole module is a client component because the Copy control writes to the
// clipboard on click — a live affordance, never a dead button (conventions: "no dead
// controls"). Everything is said in plain Australian English — no protocol or security
// jargon reaches a primary screen (brief design_ux.copy). Colour, spacing and radius come
// from the design tokens (globals.css) — never a raw hex value.

type Platform = {
  name: string;
  // Ordered steps saying exactly where to paste the Warthog address shown above.
  steps: string[];
  // A platform that cannot yet use a remote connector: the gap, plus what to do instead.
  gap?: string;
  alternative?: string;
};

// The six agent platforms the task/brief name, each with plain connect steps.
const PLATFORMS: Platform[] = [
  {
    name: "Claude",
    steps: [
      "Open Settings, then Connectors.",
      "Choose Add custom connector and paste your Warthog address.",
      "Sign in and approve what Claude may do.",
    ],
  },
  {
    name: "ChatGPT",
    steps: [
      "Open Settings, then Connectors.",
      "Add a custom connector and paste your Warthog address.",
      "Sign in to approve it.",
    ],
  },
  {
    name: "Gemini",
    steps: [
      "Open the connections (or extensions) settings.",
      "Add a custom connector and paste your Warthog address.",
      "Sign in to approve it.",
    ],
  },
  {
    name: "Grok",
    steps: [
      "Open the connections settings.",
      "Add a custom connector and paste your Warthog address.",
      "Sign in to approve it.",
    ],
  },
  {
    name: "Llama-based clients",
    steps: [
      "For clients that support custom connectors, add one and paste your Warthog address.",
      "Sign in to approve it.",
    ],
    gap: "Some Llama-based clients can't use a remote connector yet.",
    alternative: "Create an access key in Warthog and paste that in instead.",
  },
  {
    name: "Other",
    steps: [
      "Add a new custom connector in your agent.",
      "Paste your Warthog address, then sign in to approve it.",
    ],
  },
];

export function ConnectGuide({ connectorAddress }: { connectorAddress: string }) {
  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-fg">Connect an agent</h1>
        <p className="text-sm text-fg-muted">
          Add your Warthog address to each agent below and it connects straight to your
          home — never with your own logins.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-fg">Your Warthog address</h2>
        <p className="text-sm text-fg-muted">
          Copy this and paste it in when your agent asks for a custom connector.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="block min-w-0 flex-1 select-all overflow-x-auto rounded-card border border-line bg-surface-muted px-3 py-2 font-mono text-sm text-fg">
            {connectorAddress}
          </code>
          <CopyButton value={connectorAddress} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {PLATFORMS.map((platform) => (
          <article
            key={platform.name}
            className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
          >
            <h2 className="text-base font-medium text-fg">{platform.name}</h2>
            <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-fg-muted">
              {platform.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            {platform.gap ? (
              <p className="text-sm text-fg-muted">
                {platform.gap} {platform.alternative}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export default ConnectGuide;
