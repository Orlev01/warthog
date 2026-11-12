import * as React from "react";
import { LogOut } from "lucide-react";

// E04-S38 — the 'Sign out' control (src/components/shell/sign-out.tsx).
//
// A plain form that POSTs to POST /api/auth/signout, so it works WITHOUT client
// JavaScript: the server handler ends the current session, clears the host-locked
// `__Host-wh_session` cookie and redirects to /signin — the control is never a dead
// button. The lucide icon is decorative (aria-hidden); the accessible name is the
// "Sign out" text beside it.
//
// It is a presentational, shared component (no "use client", no hooks, no browser
// events), so it renders identically in the client portal chrome (the desktop sidebar
// FOOTER, via AppShell's `sidebarFooter` slot) and in the server-rendered /more page
// (the mobile More MENU, via <MoreMenu>) — the two surfaces the task names, each
// reusing this one definition rather than hand-copying the form and its endpoint.
//
// `className` carries only the per-surface padding/border/background so each surface's
// Sign out sits with its neighbours (the sidebar's footer items vs the More menu's
// cards); the layout, size (≥44px touch target) and muted secondary-action colour are
// fixed here. Colour, radius and focus come from the design tokens (globals.css).

const SIGNOUT_ACTION = "/api/auth/signout";

export function SignOutControl({
  className,
  variant = "menu",
}: {
  className?: string;
  // `sidebar`: styled exactly like a sidebar link (same edge, radius, weight and 18px icon) so
  // it sits flush under the navigation; `menu`: the stand-alone control on /more.
  variant?: "sidebar" | "menu";
}) {
  const sidebar = variant === "sidebar";
  return (
    <form method="post" action={SIGNOUT_ACTION}>
      <button
        type="submit"
        className={[
          sidebar
            ? "wh-sidebar-link w-full text-fg-muted"
            : "flex min-h-11 w-full items-center gap-3 rounded-card text-sm font-medium text-fg-muted hover:bg-surface-muted",
          className ?? "",
        ]
          .join(" ")
          .trim()}
      >
        <LogOut
          aria-hidden={true}
          className={sidebar ? "h-[18px] w-[18px] shrink-0" : "h-5 w-5 shrink-0"}
          strokeWidth={sidebar ? 1.7 : 2}
        />
        <span>Sign out</span>
      </button>
    </form>
  );
}
