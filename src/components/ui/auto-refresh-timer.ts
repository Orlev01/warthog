// When a page that lists recent activity reloads its data (the Now view): every interval while
// the person can see it, straight away when they come back to a tab that has gone stale, and
// never while they've paused it (WCAG 2.2.2 Pause, Stop, Hide) or can't see it. The decisions
// are pure so they can be tested without a browser; `auto-refresh.tsx` wires them to the page.

export interface AutoRefreshDeps {
  readonly intervalMs: number;
  // Reload the page's data (the router's refresh).
  readonly refresh: () => void;
  // Whether the page is out of sight (document.hidden).
  readonly hidden: () => boolean;
  readonly now: () => number;
  readonly setInterval: (tick: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface AutoRefresh {
  start(): void;
  stop(): void;
  // The page came into or went out of sight.
  visibilityChanged(): void;
  setPaused(paused: boolean): void;
}

export function createAutoRefresh(deps: AutoRefreshDeps): AutoRefresh {
  let paused = false;
  let last = deps.now();
  let handle: unknown = null;

  function refreshNow(): void {
    last = deps.now();
    deps.refresh();
  }
  // Out of date and in sight: reload now rather than waiting for the next tick.
  function catchUp(): void {
    if (!paused && !deps.hidden() && deps.now() - last >= deps.intervalMs) refreshNow();
  }

  return {
    start() {
      if (handle !== null) return;
      handle = deps.setInterval(() => {
        if (!paused && !deps.hidden()) refreshNow();
      }, deps.intervalMs);
    },
    stop() {
      if (handle === null) return;
      deps.clearInterval(handle);
      handle = null;
    },
    visibilityChanged: catchUp,
    setPaused(next) {
      paused = next;
      catchUp();
    },
  };
}
