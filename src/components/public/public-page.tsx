import * as React from "react";

import { RELATIVE_LINKS, type PublicLinks } from "@/server/http/website";
import { Wordmark } from "../shell/wordmark";
import { PolicyLinks } from "./policy-links";

// PublicPage — the one signed-out document frame shared by Help, Connect your agents,
// Privacy and Terms (UI/UX pass, containment-11 / public-06 / desktop-19). A full-width
// top bar (brand, Help, Sign in, Sign up) and footer bar share the landing's 1216px measure;
// the title is a heading band and the content sits in panels on the tinted public canvas, at
// a readable 800px column. Nothing here is interactive beyond links, so it renders on the
// server. Styling lives in src/app/public.css (.wh-public-*). Both the website host and the
// app host serve these pages; `links` points the brand at the website and the account links
// at the app when they have separate hosts (docs/adr/website-root-domain.md).

export type PublicPageKey = "help" | "compatibility" | "privacy" | "terms";

export function PublicPage({ title, lead, meta, current, links = RELATIVE_LINKS, children }: {
  title: string;
  lead?: React.ReactNode;
  // A short line under the lead, e.g. "Last updated 12 November 2026".
  meta?: React.ReactNode;
  // The page being shown, so its own link reads as the current page.
  current?: PublicPageKey;
  links?: PublicLinks;
  children: React.ReactNode;
}) {
  const here = (key: PublicPageKey) => (current === key ? ("page" as const) : undefined);
  return (
    <div className="wh-public">
      <a className="wh-public-skip" href="#public-content">Skip to content</a>
      <header className="wh-public-bar">
        <div className="wh-public-bar-inner">
          <Wordmark href={links.home} />
          <nav aria-label="Warthog" className="wh-public-bar-nav">
            <a href="/help" aria-current={here("help")}>Help</a>
            <a href={`${links.account}/signin`}>Sign in</a>
            <a href={`${links.account}/signup`} className="wh-public-signup">Sign up</a>
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
            <a href={`${links.account}/signin`}>Sign in</a>
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
