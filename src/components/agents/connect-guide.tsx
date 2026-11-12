"use client";

import { AGENT_PLATFORMS as PLATFORMS } from "@/domain/agents/compatibility";
import * as React from "react";
import { ChevronDown, ExternalLink } from "lucide-react";

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
// The platform guides are native disclosures, one divider row each, collapsed until a
// person opens the one for their agent — rather than nine fully expanded guides to
// scroll past. The steps stay in the markup, so find-in-page and assistive technology
// still reach them.
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
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Connect an agent</h1>
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

      <section aria-labelledby="connect-platforms-heading" className="flex flex-col gap-1">
        <h2 id="connect-platforms-heading" className="text-base font-medium text-fg">
          Steps for your agent
        </h2>
        <p className="text-sm text-fg-muted">Open the platform your agent runs on.</p>
        <ul role="list" className="mt-2 flex flex-col border-t border-line">
          {PLATFORMS.map((platform) => (
            <li key={platform.name} className="border-b border-line">
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-field py-2 text-sm font-medium text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{platform.name}</span>
                  <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
                </summary>
                <div className="flex flex-col gap-2 pb-4">
                  <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-fg-muted">
                    {platform.steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                  {"docs" in platform ? (
                    <a
                      href={platform.docs}
                      className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-medium text-fg underline underline-offset-4"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {platform.name} setup guide
                      <ExternalLink aria-hidden={true} className="h-4 w-4 shrink-0" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

export default ConnectGuide;
