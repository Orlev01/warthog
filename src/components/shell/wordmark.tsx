import * as React from "react";
import { Shield } from "lucide-react";

// Wordmark — the small Warthog product identity: the product name beside a simple
// shield-style glyph (brief design_ux.feel — a polished security-portal look). It
// is a single link whose destination the caller decides: / when signed out (the
// auth screens) and /home when signed in (the shell). The glyph is decorative
// (aria-hidden). The visible word is "Warthog"; a visually-hidden "home" gives the
// link the fuller accessible name "Warthog home" (so it reads as the home link to
// a screen reader without crowding the visible mark). Colour and radius come from
// the design tokens (globals.css) — never a raw value. It is a 44px-tall target on every
// surface (WCAG 2.5.8 and the 44px touch rule), whatever header it sits in.

export function Wordmark({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center gap-2 rounded-card text-lg font-semibold tracking-tight text-fg"
    >
      <Shield aria-hidden={true} className="h-5 w-5 shrink-0 text-accent" />
      <span>Warthog</span>
      <span className="sr-only"> home</span>
    </a>
  );
}
