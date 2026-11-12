"use client";
import * as React from "react";

// Overflow cues for any scrolling track (route tabs, in-page tabs, pill rows, the sidebar).
// While there is more to scroll towards an edge, the element carries `data-overflow-start`
// and/or `data-overflow-end`; surfaces.css turns those into a soft edge fade, so a clipped
// label reads as "more this way" rather than a rendering fault. Server markup has neither
// attribute, so nothing fades before hydration and no layout shifts when they appear.
// `slack`: hidden overflow smaller than this (e.g. the track's own end padding) is ignored.
export function useScrollEdges(
  ref: React.RefObject<HTMLElement | null>,
  axis: "x" | "y",
  slack = 1,
) {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      // Math.abs: scrollLeft runs negative in right-to-left layouts.
      const position = Math.abs(axis === "x" ? el.scrollLeft : el.scrollTop);
      const room =
        axis === "x"
          ? el.scrollWidth - el.clientWidth
          : el.scrollHeight - el.clientHeight;
      el.toggleAttribute("data-overflow-start", position > slack);
      el.toggleAttribute("data-overflow-end", position < room - slack);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [ref, axis, slack]);
}

// Bring the current tab or pill (aria-current / aria-selected) fully into its own track,
// centred where possible. Only the track scrolls: the document never moves, so a deep link or
// Back/Forward to a later tab shows the selection without jumping the page.
export function revealCurrent(track: HTMLElement) {
  const current = track.querySelector<HTMLElement>(
    '[aria-current="page"], [aria-selected="true"]',
  );
  if (!current || track.scrollWidth <= track.clientWidth) return;
  const box = track.getBoundingClientRect();
  const item = current.getBoundingClientRect();
  if (item.left >= box.left && item.right <= box.right) return;
  const delta = item.left - box.left - (box.width - item.width) / 2;
  track.scrollLeft += delta;
}
