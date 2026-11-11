"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";

const PREFERENCE_KEY = "warthog.marketing.motion";
const MotionContext = React.createContext({
  running: false,
  ready: false,
  allowed: false,
  toggle: () => {},
});

/** Progressive decoration: server-rendered content is always visible and usable. */
export function LandingMotion({ children }: { children: React.ReactNode }) {
  const root = React.useRef<HTMLDivElement>(null);
  const seen = React.useRef(new WeakSet<Element>());
  const [running, setRunning] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [allowed, setAllowed] = React.useState(false);

  React.useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const contrast = matchMedia("(forced-colors: active)");
    const sync = () => {
      const enabled = !reduced.matches && !contrast.matches;
      let paused = false;
      try { paused = sessionStorage.getItem(PREFERENCE_KEY) === "paused"; } catch { /* Storage is optional. */ }
      setAllowed(enabled);
      setRunning(enabled && !paused);
      setReady(true);
    };
    sync();
    reduced.addEventListener("change", sync);
    contrast.addEventListener("change", sync);
    return () => {
      reduced.removeEventListener("change", sync);
      contrast.removeEventListener("change", sync);
    };
  }, []);

  React.useEffect(() => {
    const page = root.current;
    if (!page || !running || typeof IntersectionObserver === "undefined") return;
    const animations = new Set<Animation>();
    const surfaces = page.querySelectorAll<HTMLElement>("[data-motion-surface]");
    const visibility = () => { page.dataset.motionVisible = String(!document.hidden); };
    visibility();
    document.addEventListener("visibilitychange", visibility);

    // Offscreen backgrounds do no animation work. Entrances run once and never
    // hide content before hydration, during failure, or when navigating by hash.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target.hasAttribute("data-motion-surface")) {
          (entry.target as HTMLElement).dataset.inView = String(entry.isIntersecting);
        }
        if (!entry.isIntersecting || !entry.target.hasAttribute("data-motion-reveal") || seen.current.has(entry.target)) continue;
        seen.current.add(entry.target);
        if (entry.target.contains(document.activeElement) || document.hidden || typeof entry.target.animate !== "function") continue;
        const animation = entry.target.animate(
          [{ transform: "translateY(14px)" }, { transform: "translateY(0)" }],
          { duration: 650, easing: "cubic-bezier(.22, 1, .36, 1)" },
        );
        animations.add(animation);
        animation.onfinish = () => animations.delete(animation);
      }
    }, { threshold: .08 });
    surfaces.forEach((surface) => observer.observe(surface));
    page.querySelectorAll("[data-motion-reveal]").forEach((element) => observer.observe(element));

    // Only fine pointers steer the artwork. Links and touch scrolling remain
    // native; no tracking, global cursor, continuous JS loop or React rerenders.
    let frame = 0;
    let pointer: { surface: HTMLElement; x: number; y: number } | null = null;
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
      const surface = (event.target as Element).closest<HTMLElement>("[data-motion-surface]");
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      pointer = { surface, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pointer) return;
        pointer.surface.style.setProperty("--wh-motion-x", `${(pointer.x - .5) * 24}px`);
        pointer.surface.style.setProperty("--wh-motion-y", `${(pointer.y - .5) * 18}px`);
      });
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
      surfaces.forEach((surface) => {
        surface.style.removeProperty("--wh-motion-x");
        surface.style.removeProperty("--wh-motion-y");
      });
    };
    page.addEventListener("pointermove", move, { passive: true });
    page.addEventListener("pointerleave", reset);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      page.removeEventListener("pointermove", move);
      page.removeEventListener("pointerleave", reset);
      animations.forEach((animation) => animation.cancel());
      reset();
    };
  }, [running]);

  const toggle = () => {
    if (!allowed) return;
    const next = !running;
    setRunning(next);
    try { sessionStorage.setItem(PREFERENCE_KEY, next ? "playing" : "paused"); } catch { /* Storage is optional. */ }
  };

  return (
    <MotionContext.Provider value={{ running, ready, allowed, toggle }}>
      <div ref={root} className="wh-landing" data-motion={running ? "on" : "off"}>
        {children}
      </div>
    </MotionContext.Provider>
  );
}

export function LandingMotionControl() {
  const { running, ready, allowed, toggle } = React.useContext(MotionContext);
  return (
    <div className="wh-landing-motion-slot">
      <button type="button" className="wh-landing-motion-control" hidden={!ready} disabled={!allowed} onClick={toggle}>
        {running ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {!allowed ? "Motion off" : running ? "Pause animations" : "Play animations"}
      </button>
    </div>
  );
}

/** Original SVG artwork inspired by flowing-line and dot-field references. */
export function LandingBackdrop() {
  return (
    <div className="wh-landing-backdrop" aria-hidden="true">
      <div className="wh-landing-backdrop-parallax">
        <svg viewBox="0 0 1200 760" fill="none" preserveAspectRatio="xMidYMid slice" focusable="false">
          <g className="wh-landing-current wh-landing-current-one" stroke="currentColor" strokeWidth=".8">
            {Array.from({ length: 28 }, (_, i) => (
              <path key={i} d={`M -100 ${430 + i * 8} C 200 ${670 + i * 3}, 360 ${-140 + i * 9}, 680 ${160 + i * 8} S 1040 ${520 + i * 4}, 1320 ${40 + i * 8}`} />
            ))}
          </g>
          <g className="wh-landing-current wh-landing-current-two" stroke="currentColor" strokeWidth=".6">
            {Array.from({ length: 14 }, (_, i) => (
              <path key={i} d={`M -100 ${140 + i * 10} C 280 ${-70 + i * 8}, 380 ${700 - i * 4}, 760 ${550 + i * 7} S 1050 ${280 + i * 9}, 1300 ${380 + i * 8}`} />
            ))}
          </g>
          <g className="wh-landing-dots" fill="currentColor">
            {Array.from({ length: 48 }, (_, i) => (
              <circle key={i} cx={80 + (i % 12) * 96} cy={100 + Math.floor(i / 12) * 160} r={i % 5 === 0 ? 2 : 1} />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
