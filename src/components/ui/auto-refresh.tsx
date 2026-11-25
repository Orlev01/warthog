"use client";

// Keeps a server-rendered page's data current while the person looks at it: the router reloads
// it every 30 seconds while the tab is in sight, at once when they come back to a stale tab, and
// not at all while they've paused it. A plain "Updated …" line says how fresh it is, without
// announcing every reload. The timing decisions live in `auto-refresh-timer.ts`.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pause } from "lucide-react";

import { Button } from "./button";
import { createAutoRefresh } from "./auto-refresh-timer";

export const AUTO_REFRESH_MS = 30_000;

export function AutoRefresh({ updatedAt, updatedAtIso }: { updatedAt: string; updatedAtIso: string }) {
  const router = useRouter();
  const [paused, setPaused] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof createAutoRefresh> | null>(null);

  React.useEffect(() => {
    const refresher = createAutoRefresh({
      intervalMs: AUTO_REFRESH_MS,
      refresh: () => router.refresh(),
      hidden: () => document.hidden,
      now: () => Date.now(),
      setInterval: (tick, ms) => window.setInterval(tick, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    });
    timer.current = refresher;
    refresher.start();
    const onVisibility = () => refresher.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      refresher.stop();
      timer.current = null;
    };
  }, [router]);

  function toggle(): void {
    const next = !paused;
    setPaused(next);
    timer.current?.setPaused(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">
      <p>
        Updated <time dateTime={updatedAtIso}>{updatedAt}</time>
        {paused ? " · updates paused" : " · checks again every 30 seconds"}
      </p>
      <Button type="button" variant="secondary" size="sm" aria-pressed={paused} onClick={toggle}>
        <Pause aria-hidden className="h-4 w-4 shrink-0" />
        Pause updates
      </Button>
    </div>
  );
}
