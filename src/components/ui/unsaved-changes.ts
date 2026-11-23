"use client";

// Unsaved changes are never thrown away silently (UI/UX audit 2026-11-23 W-03). A page wraps its
// editable area in a container and calls useUnsavedChanges(containerRef). Once the page is
// ready, the hook remembers every form control's value; while anything differs it:
//   • asks before a link takes the person to another page (an agent's other tab, the sidebar…),
//   • asks the browser to warn before a reload or close,
//   • asks before saving one form would reload the page and lose edits typed into another.
// Each <form> in the container is its own group (named by its aria-label or first heading);
// controls outside any form form one group. A control marked data-unsaved-ignore never counts.
//
// The decisions are pure functions below so they can be tested without a DOM.

import * as React from "react";

export interface ControlState {
  readonly name: string;
  readonly type: string;
  readonly checked: boolean;
  readonly value: string;
  readonly ignore?: boolean;
}

const NOT_EDITS = new Set(["hidden", "submit", "button", "reset", "image", "file"]);

/** One string for a group's controls; two equal strings mean nothing has changed. */
export function controlSignature(controls: readonly ControlState[]): string {
  return controls
    .filter((c) => !c.ignore && !NOT_EDITS.has(c.type))
    .map((c) => `${c.name}\u0000${c.type}\u0000${c.type === "checkbox" || c.type === "radio" ? String(c.checked) : c.value}`)
    .join("\u0001");
}

/** The groups whose signature differs from the baseline. A group that went away isn't an edit. */
export function changedGroups(baseline: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[] {
  const changed: string[] = [];
  for (const [key, signature] of current) {
    const before = baseline.get(key);
    if (before !== undefined && before !== signature) changed.push(key);
  }
  return changed;
}

export interface LinkClick {
  readonly href: string;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target?: string;
  readonly download?: boolean;
}

/** Whether following this click replaces the current page (so unsaved edits would be lost). */
export function linkLeavesPage(click: LinkClick, currentHref: string): boolean {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (click.download) return false;
  if (click.target && click.target !== "_self") return false;
  let to: URL;
  let from: URL;
  try {
    to = new URL(click.href, currentHref);
    from = new URL(currentHref);
  } catch {
    return false;
  }
  // A jump within the same page keeps it.
  if (to.origin === from.origin && to.pathname === from.pathname && to.search === from.search) return false;
  return true;
}

// ---- the hook (browser only) ----

type Group = { key: string; label: string; element: Element };

// A form's name as the person sees it: its aria-label, or the name of the labelled panel it
// wraps or sits in ("Shared address").
function formLabel(form: HTMLFormElement): string {
  const own = form.getAttribute("aria-label");
  if (own) return own;
  const labelled = form.querySelector("[aria-labelledby]") ?? form.closest("[aria-labelledby]");
  const id = labelled?.getAttribute("aria-labelledby")?.split(/\s+/)[0];
  const name = id ? form.ownerDocument.getElementById(id)?.textContent?.trim() : undefined;
  return name ? `“${name}”` : "another section";
}

function groupsIn(root: HTMLElement): Group[] {
  const forms = Array.from(root.querySelectorAll("form"));
  const groups: Group[] = forms.map((form, i) => ({
    key: `form-${i}`,
    label: formLabel(form),
    element: form,
  }));
  // Controls outside any form (a client-driven form such as an agent's access) are one group.
  if (Array.from(root.querySelectorAll("input, select, textarea")).some((c) => !c.closest("form"))) {
    groups.push({ key: "page", label: "this page", element: root });
  }
  return groups;
}

function controlsOf(group: Group): ControlState[] {
  const all = Array.from(group.element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"));
  return all
    .filter((c) => (group.key === "page" ? !c.closest("form") : true))
    .map((c) => ({
      name: c.name || c.id,
      type: c instanceof HTMLInputElement ? c.type : c.tagName.toLowerCase(),
      checked: c instanceof HTMLInputElement ? c.checked : false,
      value: c.value,
      ignore: c.closest("[data-unsaved-ignore]") !== null,
    }));
}

function signatures(root: HTMLElement): { map: Map<string, string>; labels: Map<string, string>; forms: Map<string, Element> } {
  const map = new Map<string, string>();
  const labels = new Map<string, string>();
  const forms = new Map<string, Element>();
  for (const group of groupsIn(root)) {
    map.set(group.key, controlSignature(controlsOf(group)));
    labels.set(group.key, group.label);
    forms.set(group.key, group.element);
  }
  return { map, labels, forms };
}

export interface UnsavedChanges {
  // True while anything in the container differs from when it was last ready or saved.
  readonly dirty: boolean;
  // Call after a successful save that keeps the page (a client-side save): the current values
  // become the new "saved" state.
  readonly markSaved: () => void;
  // The question to ask, when the person is about to lose edits; null otherwise.
  readonly pending: null | { readonly title: string; readonly description: string; readonly confirmLabel: string };
  readonly confirm: () => void;
  readonly cancel: () => void;
}

export function useUnsavedChanges(rootRef: React.RefObject<HTMLElement | null>, options: { readonly ready?: boolean } = {}): UnsavedChanges {
  const ready = options.ready ?? true;
  const baseline = React.useRef<Map<string, string> | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [pending, setPending] = React.useState<UnsavedChanges["pending"]>(null);
  const proceed = React.useRef<(() => void) | null>(null);
  const bypass = React.useRef(false);

  const changed = React.useCallback((): { keys: string[]; labels: Map<string, string>; forms: Map<string, Element> } => {
    const root = rootRef.current;
    if (!root || !baseline.current) return { keys: [], labels: new Map(), forms: new Map() };
    const now = signatures(root);
    return { keys: changedGroups(baseline.current, now.map), labels: now.labels, forms: now.forms };
  }, [rootRef]);

  const markSaved = React.useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    baseline.current = signatures(root).map;
    setDirty(false);
  }, [rootRef]);

  // Remember the values once the page is ready (after hydration).
  React.useEffect(() => {
    if (ready && baseline.current === null) markSaved();
  }, [ready, markSaved]);

  // Track edits.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setDirty(changed().keys.length > 0);
    root.addEventListener("input", update);
    root.addEventListener("change", update);
    return () => {
      root.removeEventListener("input", update);
      root.removeEventListener("change", update);
    };
  }, [rootRef, changed]);

  // Reload or close: the browser's own warning.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (bypass.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // A link to another page: ask first.
  React.useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (bypass.current || event.defaultPrevented) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const leaves = linkLeavesPage(
        {
          href: anchor.href,
          button: event.button,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          target: anchor.target || undefined,
          download: anchor.hasAttribute("download"),
        },
        window.location.href,
      );
      if (!leaves || changed().keys.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      proceed.current = () => {
        bypass.current = true;
        window.location.assign(anchor.href);
      };
      setPending({
        title: "Leave without saving?",
        description: "Your changes on this page aren't saved yet. If you leave now, they'll be lost.",
        confirmLabel: "Leave without saving",
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, changed]);

  // Saving one form reloads the page: ask before it drops edits typed into another form.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onSubmit = (event: SubmitEvent) => {
      if (bypass.current) return;
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (!form) return;
      const { keys, labels, forms } = changed();
      const others = keys.filter((key) => forms.get(key) !== form && key !== "page");
      if (others.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const submitter = event.submitter instanceof HTMLElement ? event.submitter : null;
      proceed.current = () => {
        bypass.current = true;
        form.requestSubmit(submitter as HTMLButtonElement | null ?? undefined);
        bypass.current = false;
      };
      const names = others.map((key) => labels.get(key) ?? "another section").join(", ");
      setPending({
        title: "Save this and lose your other changes?",
        description: `You've also changed ${names}, which isn't saved yet. Saving this section reloads the page and those changes will be lost. Save that section first if you want to keep them.`,
        confirmLabel: "Save this and discard the rest",
      });
    };
    root.addEventListener("submit", onSubmit, true);
    return () => root.removeEventListener("submit", onSubmit, true);
  }, [rootRef, changed]);

  const confirm = React.useCallback(() => {
    setPending(null);
    const next = proceed.current;
    proceed.current = null;
    next?.();
  }, []);
  const cancel = React.useCallback(() => {
    setPending(null);
    proceed.current = null;
  }, []);

  return { dirty, markSaved, pending, confirm, cancel };
}
