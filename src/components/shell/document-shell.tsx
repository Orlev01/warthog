import * as React from "react";

// DocumentShell — the request-varying document the (children-only) root layout
// returns. Next controls app/layout.tsx's props, so it may never be given a
// `theme`/`locale`/any extra prop; instead the layout reads the person's resolved
// preferences from the request and delegates to this plain, prop-driven,
// render-testable component (brief design_ux, technical-design §12, App-Router
// rules in conventions).
//
// It renders purely from its props with no DOM, no Next request APIs and no React
// context — which is what keeps the root layout children-only — and, like the
// other shell/ui components, does NOT import globals.css (the root layout keeps
// `import "./globals.css"`), so it stays render-testable under the plain
// `node --import tsx --test` runner.

export type Theme = "light" | "dark";

export type DocumentShellProps = {
  // The person's resolved colour preference. Applied as the data-theme hook on
  // the <html> root — the exact selector globals.css keys its token overrides on
  // (:root[data-theme="dark"] / forced-light on [data-theme="light"]) — so the
  // preference wins over the OS `prefers-color-scheme` media query.
  theme: Theme;
  // When true, disable non-essential motion for the whole document regardless of
  // the OS `prefers-reduced-motion` setting (see MOTION_OFF below).
  reducedMotion: boolean;
  // The page tree, rendered inside the document <body>.
  children: React.ReactNode;
};

// Neutralises CSS animation and transition everywhere — the unconditional twin of
// globals.css's `@media (prefers-reduced-motion: reduce)` rule, emitted only when
// the person has asked for reduced motion so the choice follows the prop rather
// than being forced on everyone.
const MOTION_OFF =
  "*,*::before,*::after{animation-duration:0.01ms !important;transition-duration:0.01ms !important;}";

export function DocumentShell({ theme, reducedMotion, children }: DocumentShellProps) {
  return (
    <html lang="en-AU" data-theme={theme}>
      <head>
        {reducedMotion ? <style>{MOTION_OFF}</style> : null}
      </head>
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
