"use client";
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
  Menu,
  Plug,
  Settings,
  Sparkles,
  SlidersHorizontal,
  Users,
  Wallet,
  X,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { Wordmark } from "./wordmark";
import { NAV_GROUPS } from "./workspace-navigation";

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  agents: Bot,
  inbox: Inbox,
  activity: Activity,
  vault: Lock,
  connectors: Plug,
  rules: SlidersHorizontal,
  spending: Wallet,
  skills: Sparkles,
  memory: Brain,
  "life-admin": ClipboardList,
  household: Users,
  settings: Settings,
  help: HelpCircle,
};
export type AppShellProps = {
  activeSection: string;
  children: React.ReactNode;
  sidebarFooter?: React.ReactNode;
};

function SidebarNavigation({
  activeSection,
  mobile = false,
}: {
  activeSection: string;
  mobile?: boolean;
}) {
  return (
    <nav
      aria-label={mobile ? "Mobile navigation" : "Primary"}
      className="wh-sidebar-nav"
    >
      {NAV_GROUPS.map((group) => (
        <section key={group.label} className="wh-nav-group">
          <h2 className="wh-nav-label">{group.label}</h2>
          {group.items.map((item) => {
            const Icon = ICONS[item.key] ?? Settings;
            return (
              <a
                key={item.key}
                href={item.href}
                aria-current={activeSection === item.key ? "page" : undefined}
                className="wh-sidebar-link"
              >
                <Icon
                  aria-hidden
                  className="h-[18px] w-[18px] shrink-0"
                  strokeWidth={1.7}
                />
                <span>{item.label}</span>
              </a>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

export function AppShell({
  activeSection,
  children,
  sidebarFooter,
}: AppShellProps) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const [open, setOpen] = React.useState(false);
  const dialogId = React.useId();
  const group = NAV_GROUPS.find((g) =>
    g.items.some((i) => i.key === activeSection),
  );
  const current = group?.items.find((i) => i.key === activeSection);
  const close = () => dialog.current?.close();
  React.useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const resize = () => {
      if (media.matches) dialog.current?.close();
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  return (
    <div className="wh-workspace">
      <a href="#workspace-content" className="wh-skip-link">
        Skip to content
      </a>
      <aside className="wh-sidebar">
        <div className="wh-sidebar-brand">
          <Wordmark href="/home" />
        </div>
        <div className="wh-workspace-label">
          <span aria-hidden className="wh-workspace-avatar">
            W
          </span>
          <span>Personal workspace</span>
        </div>
        <SidebarNavigation activeSection={activeSection} />
        {sidebarFooter && (
          <div className="wh-sidebar-footer">{sidebarFooter}</div>
        )}
      </aside>
      <dialog
        ref={dialog}
        id={dialogId}
        aria-label="Workspace navigation"
        className="wh-nav-dialog"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const r = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < r.left ||
              event.clientX > r.right ||
              event.clientY < r.top ||
              event.clientY > r.bottom
            )
              close();
          }
        }}
      >
        <div
          className="wh-drawer-content"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a[href]")) close();
          }}
        >
          <div className="wh-sidebar-brand">
            <Wordmark href="/home" />
            <button
              type="button"
              onClick={close}
              aria-label="Close navigation"
              className="wh-icon-button"
            >
              <X aria-hidden className="h-5 w-5" />
            </button>
          </div>
          <SidebarNavigation activeSection={activeSection} mobile />
          {sidebarFooter && (
            <div className="wh-sidebar-footer">{sidebarFooter}</div>
          )}
        </div>
      </dialog>
      <main id="workspace-content" tabIndex={-1} className="wh-main">
        <header className="wh-workspace-header">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls={dialogId}
            className="wh-icon-button wh-menu-trigger"
            onClick={() => {
              dialog.current?.showModal();
              setOpen(true);
            }}
          >
            <Menu aria-hidden className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="hidden text-fg-muted sm:inline">
              {group?.label ?? "Workspace"}
            </span>
            <ChevronRight
              aria-hidden
              className="hidden h-3 w-3 text-fg-muted sm:block"
            />
            <span className="truncate text-lg font-normal">
              {current?.label ??
                (activeSection === "more" ? "More" : "Warthog")}
            </span>
          </div>
          <a
            href="/help"
            aria-label="Help and support"
            className="wh-icon-button ms-auto"
          >
            <HelpCircle aria-hidden className="h-[18px] w-[18px]" />
          </a>
        </header>
        {children}
      </main>
    </div>
  );
}
