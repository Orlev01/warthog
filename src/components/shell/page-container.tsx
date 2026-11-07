import * as React from "react";

// E18-S18 — Shared page container for every portal page.
//
// Home, Rules and Security already centre their content in a width-capped box; Vault
// and Skills rendered flush against the sidebar. This is the ONE shared wrapper those
// pages put their content in so every (portal)/(protected) page is consistent:
// horizontally centred (mx-auto), width-capped (max-w-2xl) and padded (px-4 sm:px-6
// py-8), matching the existing portal containers.
//
// A plain layout wrapper — no browser events, no state — so it stays a Server
// Component and renders under the plain test runner. Pages that already carry their
// own centred container keep it and are NOT wrapped again, so no page double-pads.
export function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">{children}</div>;
}

export default PageContainer;
