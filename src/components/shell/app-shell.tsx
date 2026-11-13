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
import { NAV_GROUPS, navGroupIn, type NavGroup, type PageMeasure } from "./workspace-navigation";
import { useScrollEdges } from "./scroll-edges";

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
// What makes a shell the member portal's or the admin portal's (docs/design/admin-portal.md §5):
// its grouped destinations and their icons, where the wordmark leads, the workspace label
// under it, and the top bar's help link (null hides it rather than shipping a dead link).
// Every default is the member portal's, so the shell is unchanged without it.
export type ShellChrome = {
  groups: readonly NavGroup[];
  icons?: Record<string, LucideIcon>;
  homeHref?: string;
  workspace?: { label: string; initial: string };
  helpHref?: string | null;
};

const PORTAL_CHROME: Required<ShellChrome> = {
  groups: NAV_GROUPS,
  icons: ICONS,
  homeHref: "/home",
  workspace: { label: "Personal workspace", initial: "W" },
  helpHref: "/help",
};

function resolveChrome(chrome?: ShellChrome): Required<ShellChrome> {
  if (!chrome) return PORTAL_CHROME;
  return {
    groups: chrome.groups,
    icons: chrome.icons ? { ...ICONS, ...chrome.icons } : ICONS,
    homeHref: chrome.homeHref ?? PORTAL_CHROME.homeHref,
    workspace: chrome.workspace ?? PORTAL_CHROME.workspace,
    helpHref: chrome.helpHref === undefined ? PORTAL_CHROME.helpHref : chrome.helpHref,
  };
}

export type AppShellProps = {
  activeSection: string;
  children: React.ReactNode;
  sidebarFooter?: React.ReactNode;
  // The admin portal supplies its own groups, icons and labels; omitted, this is the member
  // portal's shell exactly as before.
  chrome?: ShellChrome;
  // The current sub-page within the section (its active route tab), shown as the last
  // breadcrumb when it differs from the section itself, e.g. Settings › Security.
  page?: { label: string; href: string };
  // The section family's page width (workspace-navigation.ts pageMeasureFor). Published as
  // data-measure so every .wh-page and the chrome above it share one left and right edge.
  measure?: PageMeasure;
  // The section's route tabs: part of the page chrome, so they sit outside <main>.
  sectionNavigation?: React.ReactNode;
};

// Group labels are plain text tied to their group (role="group" + aria-labelledby), not
// headings, so each page's outline starts with its own h1.
function SidebarNavigation({
  activeSection,
  chrome,
  mobile = false,
}: {
  activeSection: string;
  chrome: Required<ShellChrome>;
  mobile?: boolean;
}) {
  const id = React.useId();
  const ref = React.useRef<HTMLElement>(null);
  // Slack covers the list's own bottom padding, so a fully visible list never fades.
  useScrollEdges(ref, "y", 12);
  return (
    <nav
      ref={ref}
      aria-label={mobile ? "Mobile navigation" : "Primary"}
      className="wh-sidebar-nav"
    >
      {chrome.groups.map((group, index) => (
        <div
          key={group.label}
          role="group"
          aria-labelledby={`${id}-group-${index}`}
          className="wh-nav-group"
          data-label-hidden={group.hideLabel ? "" : undefined}
        >
          <p
            id={`${id}-group-${index}`}
            className={group.hideLabel ? "wh-nav-label sr-only" : "wh-nav-label"}
          >
            {group.label}
          </p>
          {group.items.map((item) => {
            const Icon = chrome.icons[item.key] ?? Settings;
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
        </div>
      ))}
    </nav>
  );
}

// Where am I: the sidebar group, the section, and the sub-page when the section has route
// tabs (Manage › Settings › Security). Phones show only the section; the page's h1 carries
// the rest. Earlier crumbs that are pages are links.
function Breadcrumb({
  activeSection,
  page,
  chrome,
}: {
  activeSection: string;
  page?: { label: string; href: string };
  chrome: Required<ShellChrome>;
}) {
  const group = navGroupIn(chrome.groups, activeSection);
  const current = group?.items.find((i) => i.key === activeSection);
  const sectionLabel =
    current?.label ?? (activeSection === "more" ? "More" : "Warthog");
  const sub = page && current?.href && page.href !== current.href ? page : undefined;
  return (
    <nav aria-label="Breadcrumb" className="wh-breadcrumb">
      <ol data-has-page={sub ? "" : undefined}>
        <li className="wh-crumb-group">{group?.label ?? "Workspace"}</li>
        <li className="wh-crumb-section">
          <ChevronRight aria-hidden className="wh-crumb-separator" />
          {sub && current?.href ? (
            <a href={current.href}>{sectionLabel}</a>
          ) : (
            <span aria-current="page">{sectionLabel}</span>
          )}
        </li>
        {sub ? (
          <li className="wh-crumb-page">
            <ChevronRight aria-hidden className="wh-crumb-separator" />
            <span aria-current="page">{sub.label}</span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}

export function AppShell({
  activeSection,
  children,
  sidebarFooter,
  page,
  measure,
  sectionNavigation,
  chrome: chromeProp,
}: AppShellProps) {
  const chrome = resolveChrome(chromeProp);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const sidebar = React.useRef<HTMLElement>(null);
  const [open, setOpen] = React.useState(false);
  const dialogId = React.useId();
  const close = () => dialog.current?.close();
  React.useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const resize = () => {
      if (!media.matches || !dialog.current?.open) return;
      // Closing returns focus to the menu button, which the desktop layout hides; move it to
      // the matching sidebar link (or the page) so keyboard focus never falls to <body>.
      dialog.current.close();
      const target =
        sidebar.current?.querySelector<HTMLElement>('a[aria-current="page"]') ??
        document.getElementById("workspace-content");
      target?.focus();
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  return (
    <div className="wh-workspace">
      <a href="#workspace-content" className="wh-skip-link">
        Skip to content
      </a>
      <aside ref={sidebar} className="wh-sidebar">
        <div className="wh-sidebar-brand">
          <Wordmark href={chrome.homeHref} size="lg" />
        </div>
        <div className="wh-workspace-label">
          <span aria-hidden className="wh-workspace-avatar">
            {chrome.workspace.initial}
          </span>
          <span>{chrome.workspace.label}</span>
        </div>
        <SidebarNavigation activeSection={activeSection} chrome={chrome} />
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
            <Wordmark href={chrome.homeHref} size="lg" />
            <button
              type="button"
              onClick={close}
              aria-label="Close navigation"
              className="wh-icon-button"
            >
              <X aria-hidden className="h-5 w-5" />
            </button>
          </div>
          <SidebarNavigation activeSection={activeSection} chrome={chrome} mobile />
          {sidebarFooter && (
            <div className="wh-sidebar-footer">{sidebarFooter}</div>
          )}
        </div>
      </dialog>
      <div className="wh-main" data-measure={measure}>
        <header className="wh-workspace-header">
          <div className="wh-workspace-header-inner">
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
            <Breadcrumb activeSection={activeSection} page={page} chrome={chrome} />
            {chrome.helpHref ? (
              <a
                href={chrome.helpHref}
                aria-label="Help and support"
                className="wh-icon-button wh-help-link"
              >
                <HelpCircle aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.7} />
              </a>
            ) : null}
          </div>
        </header>
        {sectionNavigation}
        <main id="workspace-content" tabIndex={-1} className="wh-content">
          {children}
        </main>
      </div>
    </div>
  );
}
