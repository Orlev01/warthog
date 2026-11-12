"use client";
import * as React from "react";

// Sets the browser tab title from inside a segment that can't export metadata (a nested
// not-found boundary), so the tab names what the page shows (WCAG 2.4.2 Page Titled). The
// framework may write the route's own metadata title after hydration, so the title is
// re-asserted whenever <head> changes while this is mounted. The workspace's links are full
// page loads, so nothing else writes a title while it is on screen.
export function DocumentTitle({ title }: { title: string }) {
  React.useEffect(() => {
    const apply = () => {
      if (document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [title]);
  return null;
}
