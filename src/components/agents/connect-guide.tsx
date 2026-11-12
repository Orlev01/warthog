"use client";

import { AGENT_PLATFORMS as PLATFORMS } from "@/domain/agents/compatibility";
import { AgentMark } from "@/components/ui/brand-mark";
import * as React from "react";
import { ChevronDown, ExternalLink, KeyRound, Link2, ListChecks } from "lucide-react";

import { CopyButton } from "@/components/ui/copy-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { ListGroup } from "@/components/ui/list-group";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";

// E10-S04 — Guided connect view per platform (brief "Connect an agent").
//
// A signed-in person on the Agents area needs plain, per-platform steps for pasting
// Warthog's connector address into each AI client, a button to copy that address, and
// — where a platform cannot yet use a remote connector — a note of that gap and what to
// do instead. From ONE render-testable component it shows:
//   • what happens, in three steps (copy the address, add it in the agent, approve its
//     access in Warthog — after which it appears in Your agents), with the address and
//     its COPY control in the first step (newcomer-07), and
//   • ORDERED steps per platform: the common ones first (Claude opened), the rest under
//     "Other platforms", and the ones Warthog has no documented way to connect yet apart,
//     marked "Not verified yet", and
//   • the access-key route for an agent that can't add a connector.
//
// The connector address is config-driven (INV-21 / constitution #21: the public address
// is read from configuration — the public base URL — never hard-coded in a component).
// src/components/** is PURE (no config, no DB), so it arrives as a PROP: the page/entry
// that mounts this view derives it from `config.publicBaseUrl` and passes it in, exactly
// as the sibling public Help view takes `connectorAddress`. The view DISPLAYS whatever
// address it is given (so swapping the config value swaps what the screen shows and what
// Copy copies) and bakes no address in.
//
// The platform guides are native disclosures, one divider row each, so the steps stay in
// the markup for find-in-page and assistive technology. Every text block sits in the
// heading band or a panel (founder rule 1).
//
// This whole module is a client component because the Copy control writes to the
// clipboard on click — a live affordance, never a dead button (conventions: "no dead
// controls"). Everything is said in plain Australian English — no protocol or security
// jargon reaches a primary screen (brief design_ux.copy). Colour, spacing and radius come
// from the design tokens — never a raw hex value.

type Platform = (typeof PLATFORMS)[number];

// The order the guide lists platforms in: the common ones first, then the rest, then the
// ones with no documented way to connect yet.
export const CONNECT_GROUPS: readonly { id: string; title: string; summary?: string; platforms: readonly Platform[] }[] = [
  {
    id: "connect-common",
    title: "Most common",
    platforms: PLATFORMS.filter((p) => "featured" in p && p.featured),
  },
  {
    id: "connect-other",
    title: "Other platforms",
    platforms: PLATFORMS.filter((p) => !("featured" in p && p.featured) && p.status !== "unverified"),
  },
  {
    id: "connect-unverified",
    title: "Not verified yet",
    summary: "Warthog hasn’t found a documented way to connect these yet.",
    platforms: PLATFORMS.filter((p) => p.status === "unverified"),
  },
];

function PlatformGuide({ platform, open }: { platform: Platform; open: boolean }) {
  const unverified = platform.status === "unverified";
  return (
    <li className="border-b border-line last:border-0">
      <details className="group" open={open}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-field py-2 text-sm text-fg [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-3 [overflow-wrap:anywhere]">
            <AgentMark platform={platform.name} name={platform.name} size="sm" />
            <span className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                {platform.name}
                {unverified ? <Badge tone="warning">Not verified yet</Badge> : null}
              </span>
              <span className="text-fg-muted">{platform.summary}</span>
            </span>
          </span>
          <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-2 pb-4 ps-11">
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
  );
}

// One numbered step of "How to connect".
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3">
      <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-medium text-fg-muted">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <h3 className="wh-group-title">{title}</h3>
        {children}
      </div>
    </li>
  );
}

export function ConnectGuide({ connectorAddress }: { connectorAddress: string }) {
  const first = PLATFORMS[0]!.name;
  return (
    <>
      <WorkspaceHeading
        title="Connect an agent"
        description="Add Warthog to your AI assistant, then choose what it can use. Each agent gets its own permissions, memory controls, card budget and activity record."
      />

      <WorkspacePanel title="How to connect" icon={Link2} description="Three steps, then the agent is ready to use.">
        <ol className="flex flex-col gap-5">
          <Step n={1} title="Copy your Warthog address">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="block min-w-0 flex-1 select-all overflow-x-auto rounded-field bg-surface-muted px-3 py-2 font-mono text-sm text-fg">
                {connectorAddress}
              </code>
              <CopyButton value={connectorAddress} label="Warthog address" />
            </div>
          </Step>
          <Step n={2} title="Add it in your agent’s settings">
            <p className="text-sm text-fg-muted">
              Paste the address where your agent adds a custom connector (that’s what Claude
              and ChatGPT call it). The steps for each platform are below. If your agent
              can’t add one, <a href="/agents/access-key" className="font-medium text-fg underline underline-offset-4">use an access key instead</a>.
            </p>
          </Step>
          <Step n={3} title="Sign in and choose its access">
            <p className="text-sm text-fg-muted">
              Your agent opens Warthog so you can sign in and choose what it may use. Once you
              approve, it appears in Your agents, and anything that needs your OK waits in your
              Inbox.
            </p>
          </Step>
        </ol>
      </WorkspacePanel>

      <WorkspacePanel title="Steps for your agent" icon={ListChecks} description="Open the platform your agent runs on.">
        {CONNECT_GROUPS.filter((group) => group.platforms.length > 0).map((group) => (
          <ListGroup key={group.id} id={group.id} level={3} title={group.title} summary={group.summary}>
            {group.platforms.map((platform) => (
              <PlatformGuide key={platform.name} platform={platform} open={platform.name === first} />
            ))}
          </ListGroup>
        ))}
      </WorkspacePanel>

      <WorkspacePanel
        title="Can’t add a connector?"
        icon={KeyRound}
        description="Some agents can’t sign in through a connector yet. Create an access key for the agent and paste that in instead. You can replace or revoke it later in the agent’s Settings."
        footer={<ButtonLink href="/agents/access-key">Create an access key</ButtonLink>}
      />
    </>
  );
}

export default ConnectGuide;
