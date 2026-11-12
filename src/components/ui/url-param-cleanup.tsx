"use client";
import * as React from "react";

// Removes one-shot query parameters (an outcome notice such as `?notice=saved`) from the
// address bar once the page that shows them has rendered, so a refresh, Back/Forward or a
// bookmark doesn't replay a stale "Saved." and a tab switch never carries it along. The page
// itself is unchanged; only the URL is tidied, through the router-aware history API.
export function UrlParamCleanup({ names }: { names: readonly string[] }) {
  const key = names.join("|");
  React.useEffect(() => {
    const url = new URL(window.location.href);
    let changed = false;
    for (const name of key.split("|")) {
      if (name && url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (changed) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [key]);
  return null;
}
