import * as React from "react";
import { Link2, Bot, ShieldCheck } from "lucide-react";

import { Wordmark } from "../shell/wordmark";
import { PolicyLinks } from "./policy-links";

// Shared call-to-action link styling — a ≥44px target with a visible focus ring,
// built on the same design tokens as the Button primitive (globals.css). The
// landing's one accent action is Sign up; Sign in is the neutral surface link.
const CTA_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const CTA_PRIMARY = `${CTA_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const CTA_SECONDARY = `${CTA_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;

// Landing — the public front door (brief feature "Public landing page";
// design_ux primary_journey "LANDING"). It shows, from ONE render-testable
// component, the four things the LANDING surface promises: the positioning line,
// the plain three-step explanation, the agent compatibility list, and Sign up /
// Sign in. The page entry (src/app/page.tsx) is a thin shell over this component.
//
// Everything here is said in plain Australian English — no protocol or security
// jargon reaches a primary screen (brief design_ux.copy; constitution INV-22).
// Colour, spacing and radius come from the design tokens (globals.css) via the
// Button/Wordmark primitives and token classes — never a raw hex value.

// The plain three steps (brief: "connect your services once; connect your agents;
// approve and see everything"). The glyphs are decorative (aria-hidden).
const STEPS = [
  {
    icon: Link2,
    title: "Connect your services once",
    body: "Link your calendar, email and the rest to Warthog a single time. Agents reach them only through your home, never with your own logins.",
  },
  {
    icon: Bot,
    title: "Connect your agents",
    body: "Add each AI agent with its own sign-in that you can switch off on its own, any time, without touching the others.",
  },
  {
    icon: ShieldCheck,
    title: "Approve and see everything",
    body: "Warthog asks you first before anything sensitive happens, and keeps a plain record of everything your agents do.",
  },
] as const;

// The compatible agent platforms the brief names (overview; "Connect an agent").
const COMPATIBLE_AGENTS = [
  "Claude",
  "ChatGPT",
  "Gemini",
  "Grok",
  "Llama-based clients",
] as const;

export function Landing() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-6">
        <Wordmark href="/" />
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Your agents work for you, on your terms, from your home.
        </h1>
        <p className="max-w-prose text-base text-fg-muted">
          Warthog is the one place you own that every AI agent connects through —
          holding who you are, what each agent may touch and spend, and a record of
          everything they do.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href="/signup" className={CTA_PRIMARY}>
            Sign up
          </a>
          <a href="/signin" className={CTA_SECONDARY}>
            Sign in
          </a>
        </div>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">How it works</h2>
        <ol className="flex flex-col gap-4">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <li
                key={step.title}
                className="flex gap-4 rounded-card border border-line bg-surface p-4"
              >
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-accent-soft text-accent"
                  aria-hidden={true}
                >
                  <Icon className="h-5 w-5" aria-hidden={true} />
                </span>
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-fg">
                    {index + 1}. {step.title}
                  </span>
                  <span className="text-sm text-fg-muted">{step.body}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Works with your agents</h2>
        <p className="text-sm text-fg-muted">
          Warthog works with the agents you already use.
        </p>
        <ul className="flex flex-wrap gap-2">
          {COMPATIBLE_AGENTS.map((agent) => (
            <li
              key={agent}
              className="rounded-card border border-line bg-surface px-3 py-2 text-sm font-medium text-fg"
            >
              {agent}
            </li>
          ))}
        </ul>
      </section>
      <footer><PolicyLinks /></footer>
    </main>
  );
}
