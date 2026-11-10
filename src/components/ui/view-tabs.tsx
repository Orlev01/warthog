"use client";
import * as React from "react";

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
export function ViewPanels({
  label,
  tabs,
  initialTab,
  defaultTab,
  parameter = "view",
}: {
  label: string;
  tabs: readonly ViewTab[];
  initialTab?: string;
  defaultTab?: string;
  parameter?: string;
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
  return (
    <>
      <div role="tablist" aria-label={label} className="wh-tabs">
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            className={selected === tab.key ? "wh-tab font-semibold" : "wh-tab"}
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
      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={`${id}-panel-${tab.key}`}
          aria-labelledby={`${id}-${tab.key}`}
          hidden={selected !== tab.key}
          tabIndex={0}
          className="wh-tabpanel"
        >
          {tab.content}
        </div>
      ))}
    </>
  );
}
