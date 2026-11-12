import * as React from "react";

const LINK =
  "inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

// The policy links every public footer carries. Account-entry screens also pass `help`,
// because /help is the page a locked-out person needs (public-27).
export function PolicyLinks({ help = false }: { help?: boolean }) {
  return <nav aria-label="Policies" className="flex flex-wrap justify-center gap-x-5 py-4 text-sm text-fg-muted">
    {help ? <a href="/help" className={LINK}>Help</a> : null}
    <a href="/privacy" className={LINK}>Privacy</a>
    <a href="/terms" className={LINK}>Terms</a>
  </nav>;
}
