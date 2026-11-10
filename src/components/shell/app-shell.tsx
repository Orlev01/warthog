import * as React from "react";
import {
  Activity,
  Bot,
  Brain,
  ClipboardList,
  Home,
  HelpCircle,
  Inbox,
  Lock,
  MoreHorizontal,
  Plug,
  Settings,
  Sparkles,
  SlidersHorizontal,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { Wordmark } from "./wordmark";

// AppShell — the prop-driven app frame that gives every signed-in screen one
// fixed navigation, built on the design tokens (globals.css). Two surfaces share
// a single information architecture (brief design_ux.feel, technical-design §12):
//   • a mobile bottom nav — the five top-level sections (Home, Inbox, Activity,
//     Agents, More), shown under 1024px;
//   • a desktop sidebar — the same five sections PLUS the "More" children, shown
//     from 1024px up.
// Everything is reachable in two taps. The icon on each item is decorative
// (aria-hidden) so the accessible name is the word beside it. Colour, radius and
// focus come from tokens, never raw values.

type NavItem = {
  // Stable key matched against `activeSection` to mark the current item.
  key: string;
  // The visible, accessible label (the word a sighted reader sees).
  label: string;
  href: string;
  Icon: LucideIcon;
};

// The four top-level destination sections, in documented left-to-right order.
const SECTIONS: readonly NavItem[] = [
  { key: "home", label: "Home", href: "/home", Icon: Home },
  { key: "inbox", label: "Inbox", href: "/inbox", Icon: Inbox },
  { key: "activity", label: "Activity", href: "/activity", Icon: Activity },
  { key: "agents", label: "Agents", href: "/agents", Icon: Bot },
];

// "More" — the fifth bottom-nav item; on the sidebar it is the heading over its
// children, on the bottom nav it is the link to the full menu.
const MORE: NavItem = { key: "more", label: "More", href: "/more", Icon: MoreHorizontal };

// The "More" children — reachable directly in the sidebar, and behind "More" on
// mobile. Copy and routes per the brief (design_ux) and technical-design §1.
const MORE_CHILDREN: readonly NavItem[] = [
  { key: "vault", label: "Vault", href: "/vault", Icon: Lock },
  { key: "connectors", label: "Connectors", href: "/connectors", Icon: Plug },
  { key: "rules", label: "Rules & budgets", href: "/rules", Icon: SlidersHorizontal },
  { key: "spending", label: "Spending", href: "/spending", Icon: Wallet },
  { key: "skills", label: "Skills", href: "/skills", Icon: Sparkles },
  { key: "memory", label: "Memory", href: "/memory", Icon: Brain },
  { key: "life-admin", label: "Life admin", href: "/life-admin", Icon: ClipboardList },
  { key: "household", label: "Household", href: "/household", Icon: Users },
  { key: "settings", label: "Settings", href: "/settings", Icon: Settings },
  { key: "help", label: "Help", href: "/help", Icon: HelpCircle },
];

// The bottom nav carries the five top-level sections, in order.
const BOTTOM_ITEMS: readonly NavItem[] = [...SECTIONS, MORE];

export type AppShellProps = {
  // Which navigation section is current (e.g. "home", "inbox", "vault"). Both
  // surfaces mark the matching item with aria-current.
  activeSection: string;
  // The page content, rendered inside the <main> landmark.
  children: React.ReactNode;
  // Optional footer content for the desktop sidebar, pinned to the bottom of the
  // sidebar below the navigation (e.g. the 'Sign out' control). Omitted on the
  // mobile bottom nav, which carries only the five top-level sections.
  sidebarFooter?: React.ReactNode;
};

// A bottom-nav item: icon over label, a ≥44px touch target. The current item is shown by
// more than colour (WCAG 1.4.1): an accent bar along its top edge and heavier text as well
// as the accent colour. aria-current is set only on the current item (omitted otherwise).
function BottomItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <a
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 border-t-2 py-2 text-xs",
        active ? "border-accent font-semibold text-accent" : "border-transparent font-medium text-fg-muted",
      ].join(" ")}
    >
      <item.Icon aria-hidden={true} className="h-5 w-5 shrink-0" />
      <span>{item.label}</span>
    </a>
  );
}

// A sidebar link: icon beside label, a ≥44px target. The current item sits on the soft
// accent background AND carries an accent bar on its leading edge and heavier text, so it
// is never shown by colour alone (WCAG 1.4.1). aria-current is set only on the current item.
function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <a
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex min-h-11 items-center gap-3 rounded-card border-s-4 px-3 py-2 text-sm",
        active
          ? "border-accent bg-accent-soft font-semibold text-accent"
          : "border-transparent font-medium text-fg hover:bg-surface-muted",
      ].join(" ")}
    >
      <item.Icon aria-hidden={true} className="h-5 w-5 shrink-0" />
      <span>{item.label}</span>
    </a>
  );
}

export function AppShell({ activeSection, children, sidebarFooter }: AppShellProps) {
  return (
    <div className="min-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] bg-bg text-fg lg:flex">
      {/* Desktop sidebar (≥1024px): the five sections plus the More children.
          Sticky to the viewport height with its own overflow scroll, so its
          footer (Sign out) stays reachable at short viewport heights without
          scrolling the page. */}
      <nav
        aria-label="Primary"
        className="hidden shrink-0 border-e border-line bg-surface p-3 lg:sticky lg:top-[env(safe-area-inset-top)] lg:flex lg:h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] lg:w-64 lg:flex-col lg:gap-1 lg:overflow-y-auto"
      >
        <div className="px-1 pb-3 pt-1">
          <Wordmark href="/home" />
        </div>
        {SECTIONS.map((item) => (
          <SidebarLink key={item.key} item={item} active={item.key === activeSection} />
        ))}
        <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {MORE.label}
        </p>
        {MORE_CHILDREN.map((item) => (
          <SidebarLink key={item.key} item={item} active={item.key === activeSection} />
        ))}
        {/* Sidebar footer, pinned to the bottom below the navigation. */}
        {sidebarFooter != null && (
          <div className="mt-auto border-t border-line pt-3">{sidebarFooter}</div>
        )}
      </nav>

      {/* Page content. Extra block padding on mobile clears the fixed bottom nav. */}
      <main className="min-w-0 flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</main>

      {/* Mobile bottom nav (<1024px): exactly the five top-level sections. */}
      <nav
        aria-label="Primary"
        className="fixed bottom-0 start-0 end-0 z-30 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] lg:hidden"
      >
        {BOTTOM_ITEMS.map((item) => (
          <BottomItem key={item.key} item={item} active={item.key === activeSection} />
        ))}
      </nav>
    </div>
  );
}
