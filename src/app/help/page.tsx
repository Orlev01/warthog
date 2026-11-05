import * as React from "react";

import { Wordmark } from "@/components/shell/wordmark";

// E18-S16 — Help page entry (`/help`). A PUBLIC page, reachable by anyone with NO
// authentication: it sits at the top level, under no guard layout, because a person
// locked out of their account still needs help. It explains, in plain Australian
// English, what Warthog is, how to connect an agent (linking /help/compatibility),
// how approvals and "Ask me first" work, how to recover an account (linking /recover)
// and the privacy summary (linking /privacy).
//
// The screen is static — it needs no session and no config — so the entry mounts it
// directly. No protocol or security jargon reaches this primary screen (brief
// design_ux.copy): no "OAuth", "MCP", "DCR" or "token" in the copy. Colour, spacing
// and radius come from the design tokens (globals.css) — never a raw hex value.

// A neutral, button-sized navigation link (≥44px target, visible focus ring) built on
// the same design tokens as the landing's secondary call to action.
const NAV_LINK =
  "inline-flex min-h-11 w-fit items-center justify-center rounded-card border border-line bg-surface px-4 text-sm font-medium text-fg transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export default function HelpPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-6">
        <Wordmark href="/" />
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Help
        </h1>
        <p className="max-w-prose text-base text-fg-muted">
          Warthog is the one place you own that every AI agent connects through. It
          holds who you are, what each agent may touch and spend, and a plain record
          of everything your agents do. This page covers the basics; you can read it
          even when you&#39;re locked out of your account.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Connecting an agent</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Each AI agent connects to Warthog with its own sign-in that you can switch
          off on its own, at any time, without touching your other agents. Agents
          reach your connected services only through Warthog — never with your own
          logins.
        </p>
        <a href="/help/compatibility" className={NAV_LINK}>
          See how to connect your agent
        </a>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">
          Approvals and &#39;Ask me first&#39;
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Before anything sensitive happens — sharing your details, spending money or
          making a change you&#39;d want to know about — Warthog pauses and asks you
          first. You approve or decline each request yourself, signed in to Warthog.
        </p>
        <p className="max-w-prose text-sm text-fg-muted">
          Turn on &#39;Ask me first&#39; for anything you always want to check, and
          Warthog holds the request until you say yes.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Recovering your account</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Locked out? You can get back into your account using the recovery codes you
          saved when you signed up. If you&#39;ve lost those too, Warthog can walk you
          through how to recover your account step by step.
        </p>
        <a href="/recover" className={NAV_LINK}>
          Recover your account
        </a>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Your privacy</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Your details, your cards and the record of what your agents do are yours.
          You can export everything or delete your account yourself at any time. Our
          privacy policy explains what is stored, where it is kept, and who can read
          it.
        </p>
        <a href="/privacy" className={NAV_LINK}>
          Read the privacy policy
        </a>
      </section>
    </main>
  );
}
