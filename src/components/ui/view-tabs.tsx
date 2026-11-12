"use client";
import * as React from "react";
import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";
import { revealCurrent, useScrollEdges } from "@/components/shell/scroll-edges";

export function resolveView(
  value: string | null,
  keys: readonly string[],
  fallback: string,
) {
  return value !== null && keys.includes(value) ? value : fallback;
}
export function nextTabIndex(
  current: number,
  key: string,
  count: number,
): number | null {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

// Validate URL state, preserve unrelated filters, and restore the selected view
// with Back/Forward. Keep forms mounted so changing tabs does not discard drafts.
export function useQueryView<T extends string>(
  keys: readonly T[],
  fallback: T,
  parameter = "view",
  initialSelection?: string,
) {
  const [selected, setSelected] = React.useState<T>(
    () => resolveView(initialSelection ?? null, keys, fallback) as T,
  );
  const keyList = keys.join("|");
  React.useEffect(() => {
    const restore = () =>
      setSelected(
        resolveView(
          new URLSearchParams(window.location.search).get(parameter),
          keyList.split("|"),
          fallback,
        ) as T,
      );
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [keyList, fallback, parameter]);
  const select = (key: T) => {
    if (!keys.includes(key)) return;
    const url = new URL(window.location.href);
    // An outcome notice belongs to the submission that produced it, not to the next view.
    url.searchParams.delete("notice");
    if (key === fallback) url.searchParams.delete(parameter);
    else url.searchParams.set(parameter, key);
    if (url.href !== window.location.href)
      window.history.pushState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    setSelected(key);
  };
  return [selected, select] as const;
}

export type ViewTab = { key: string; label: string; content: React.ReactNode };

// The page heading that owns these tabs, when they are the page's first navigation under its
// title: the tablist then sits in the heading band's nav row (one band, not two).
export type ViewPanelsHeading = {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  scope?: boolean;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

// In-page views (ARIA tabs with roving focus, arrows/Home/End) whose panels all stay mounted,
// so drafts survive a switch. The tablist is bounded: a strip of its own, or the nav row of
// `heading`. It scrolls within itself on narrow screens, keeps the selected tab in view and
// fades the clipped edge. A panel is a Tab stop only while it has nothing focusable inside.
export function ViewPanels({
  label,
  tabs,
  initialTab,
  defaultTab,
  parameter = "view",
  heading,
}: {
  label: string;
  tabs: readonly ViewTab[];
  initialTab?: string;
  defaultTab?: string;
  parameter?: string;
  heading?: ViewPanelsHeading;
}) {
  const fallback =
    defaultTab && tabs.some((t) => t.key === defaultTab)
      ? defaultTab
      : tabs[0]!.key;
  const [selected, select] = useQueryView(
    tabs.map((t) => t.key),
    fallback,
    parameter,
    initialTab,
  );
  const id = React.useId();
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const track = React.useRef<HTMLDivElement>(null);
  const panels = React.useRef<Record<string, HTMLDivElement | null>>({});
  const [withControls, setWithControls] = React.useState<Record<string, boolean>>({});
  useScrollEdges(track, "x");
  React.useEffect(() => {
    if (track.current) revealCurrent(track.current);
  }, [selected]);
  React.useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const [key, panel] of Object.entries(panels.current))
      next[key] = Boolean(panel?.querySelector(FOCUSABLE));
    setWithControls((prev) =>
      Object.keys(next).every((k) => prev[k] === next[k]) ? prev : next,
    );
  }, [selected, tabs]);
  const tablist = (
    <div ref={track} role="tablist" aria-label={label} className="wh-tabs">
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          className="wh-tab"
          data-label={tab.label}
          ref={(el) => {
            refs.current[index] = el;
          }}
          id={`${id}-${tab.key}`}
          aria-controls={`${id}-panel-${tab.key}`}
          aria-selected={selected === tab.key}
          tabIndex={selected === tab.key ? 0 : -1}
          onClick={() => select(tab.key)}
          onKeyDown={(event) => {
            const next = nextTabIndex(index, event.key, tabs.length);
            if (next === null) return;
            event.preventDefault();
            select(tabs[next]!.key);
            refs.current[next]?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
  return (
    <>
      {heading ? (
        <WorkspaceHeading
          eyebrow={heading.eyebrow}
          title={heading.title}
          description={heading.description}
          meta={heading.meta}
          scope={heading.scope}
          nav={tablist}
        >
          {heading.actions}
        </WorkspaceHeading>
      ) : (
        <div className="wh-tabstrip">{tablist}</div>
      )}
      {tabs.map((tab) => (
        <div
          key={tab.key}
          ref={(el) => {
            panels.current[tab.key] = el;
          }}
          role="tabpanel"
          id={`${id}-panel-${tab.key}`}
          aria-labelledby={`${id}-${tab.key}`}
          hidden={selected !== tab.key}
          tabIndex={withControls[tab.key] ? undefined : 0}
          className="wh-tabpanel"
        >
          {tab.content}
        </div>
      ))}
    </>
  );
}
