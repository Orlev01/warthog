"use client";

// A pending request's "time left", kept live (UI/UX audit 2026-11-23 W-02). The server renders
// the same label first, so hydration matches; the browser then recounts every 30 seconds and
// reads "Expired" once the window has passed, instead of a countdown frozen at page load.

import * as React from "react";

import { timeLeftLabel } from "@/domain/approvals/expiry-copy";

const TICK_MS = 30_000;

export function LiveTimeLeft({ initial, expiresAtMs }: { initial: string; expiresAtMs?: number }): React.ReactElement {
  const [label, setLabel] = React.useState(initial);
  React.useEffect(() => {
    if (expiresAtMs === undefined) return;
    const update = () => setLabel(timeLeftLabel(Math.max(0, expiresAtMs - Date.now())));
    update();
    const timer = window.setInterval(update, TICK_MS);
    return () => window.clearInterval(timer);
  }, [expiresAtMs]);
  return <>{label}</>;
}
