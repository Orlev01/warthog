import * as React from "react";

export function PolicyLinks() {
  return <nav aria-label="Policies" className="flex justify-center gap-5 py-4 text-sm text-fg-muted">
    <a href="/privacy" className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Privacy</a>
    <a href="/terms" className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Terms</a>
  </nav>;
}
