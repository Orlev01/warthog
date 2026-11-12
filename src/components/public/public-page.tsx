import * as React from "react";

import { Wordmark } from "../shell/wordmark";
import { PolicyLinks } from "./policy-links";

// PublicPage — the one signed-out document frame shared by Help, Connect your agents,
// Privacy and Terms (UI/UX pass, containment-11 / public-06 / desktop-19). A full-width
// top bar (brand, Help, Sign in, Sign up) and footer bar share the landing's 1216px measure;
// the title is a heading band and the content sits in panels on the tinted public canvas, at
// a readable 800px column. Nothing here is interactive beyond links, so it renders on the
// server. Styling lives in src/app/public.css (.wh-public-*).

export type PublicPageKey = "help" | "compatibility" | "privacy" | "terms";

export function PublicPage({ title, lead, meta, current, children }: {
  title: string;
  lead?: React.ReactNode;
  // A short line under the lead, e.g. "Last updated 12 November 2026".
  meta?: React.ReactNode;
  // The page being shown, so its own link reads as the current page.
  current?: PublicPageKey;
  children: React.ReactNode;
}) {
  const here = (key: PublicPageKey) => (current === key ? ("page" as const) : undefined);
  return (
    <div className="wh-public">
      <a className="wh-public-skip" href="#public-content">Skip to content</a>
      <header className="wh-public-bar">
        <div className="wh-public-bar-inner">
          <Wordmark href="/" />
          <nav aria-label="Warthog" className="wh-public-bar-nav">
            <a href="/help" aria-current={here("help")}>Help</a>
            <a href="/signin">Sign in</a>
            <a href="/signup" className="wh-public-signup">Sign up</a>
          </nav>
        </div>
      </header>
      <main id="public-content" tabIndex={-1} className="wh-public-main">
        <header className="wh-public-title">
          <h1>{title}</h1>
          {lead ? <p>{lead}</p> : null}
          {meta ? <p className="wh-public-meta">{meta}</p> : null}
        </header>
        {children}
      </main>
      <footer className="wh-public-bar">
        <div className="wh-public-bar-inner wh-public-footer-inner">
          <nav aria-label="Support" className="wh-public-bar-nav">
            <a href="/help" aria-current={here("help")}>Help</a>
            <a href="/help/compatibility" aria-current={here("compatibility")}>Connect your agents</a>
            <a href="/signin">Sign in</a>
          </nav>
          <PolicyLinks />
        </div>
      </footer>
    </div>
  );
}

// One bounded panel. Sections inside it are divided by rules, not nested cards.
export function PublicPanel({ children, label }: { children: React.ReactNode; label?: string }) {
  return <div className="wh-public-panel" role={label ? "group" : undefined} aria-label={label}>{children}</div>;
}

// A titled section inside a panel.
export function PublicSection({ id, title, children }: { id: string; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="wh-public-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}
