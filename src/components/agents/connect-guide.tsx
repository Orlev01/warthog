"use client";

import { AGENT_PLATFORMS as PLATFORMS } from "@/domain/agents/compatibility";
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

export function ConnectGuide({ connectorAddress }: { connectorAddress: string }) {
  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-fg">Connect an agent</h1>
        <p className="text-sm text-fg-muted">
          Connect compatible agents using the address below. Each connection gets its own permissions, memory controls, budget and audit log.
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
            {"docs" in platform ? <a href={platform.docs} className="text-sm text-accent underline" target="_blank" rel="noreferrer">Provider setup guide</a> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export default ConnectGuide;
