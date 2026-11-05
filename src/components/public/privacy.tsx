import * as React from "react";

import { Wordmark } from "../shell/wordmark";

// Privacy — the public privacy policy / security-FAQ VIEW (brief feature "Agent
// compatibility and help pages"; data-rights principle 20). From ONE render-testable
// component it makes, in plain Australian English, the plain statement the privacy
// rights constraint requires:
//   • WHAT is stored and WHERE (Australia);
//   • that your most sensitive (high-tier) identity details AND your cards are
//     encrypted on your own device, so neither Warthog's servers nor its staff can
//     read them while they are stored;
//   • that those device-protected values pass through Warthog only for the single
//     release you approve, and are discarded once collected or expired; and
//   • HOW to export everything or delete the account.
// The page entry (src/app/privacy/page.tsx) is a thin shell over this component.
//
// Its content is static (no config-driven value is in scope), so — like Landing — it
// takes no props and stays pure (no config, no DB). Colour, spacing and radius come
// from the design tokens (globals.css) — never a raw hex value. The security FAQ may
// use security words like "encryption" (brief design_ux.copy expressly permits them
// here); the rest stays plain Australian English.

export function Privacy() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-6">
        <Wordmark href="/" />
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Your privacy and security
        </h1>
        <p className="max-w-prose text-base text-fg-muted">
          Warthog is the home you own. Here is a plain statement of what we store,
          where we keep it, who can read it, and how you take it back.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">What we store, and where</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Every byte of your data is stored on servers in Australia and never moved
          offshore. We keep your identity details, your cards, the activity record of
          what your agents do, your memory and skills, and the rules and budgets you
          set for each agent.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">
          Your most sensitive details stay locked to your device
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">
          Your most sensitive identity details &mdash; such as your passport or licence
          numbers &mdash; and your cards are encrypted on your own device, with a key
          that stays with you. Warthog only ever stores the scrambled version.
        </p>
        <p className="max-w-prose text-sm text-fg-muted">
          That means Warthog&#39;s servers cannot read them, and not even our staff can
          unlock them while they are stored. We show only your card&#39;s brand and last
          four digits, and we never keep a card&#39;s security code at all.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">A release only happens when you approve it</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          When an agent needs one of these details or a card, that value passes through
          Warthog once &mdash; only for the single release you approve from inside the
          app &mdash; and is discarded the moment it has been handed over or the request
          expires. It is never kept afterwards.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Export or delete everything, any time</h2>
        <p className="max-w-prose text-sm text-fg-muted">
          You can export everything Warthog holds about you whenever you like, and you
          can delete your account &mdash; and all of your data with it &mdash; yourself,
          at any time, from your settings.
        </p>
      </section>
    </main>
  );
}
