// Keyboard focus across a save (WCAG 2.4.3). A server action usually ends with a redirect to
// the same page (`?notice=saved`); Next re-renders the route and the form that was submitted
// is a fresh element, so the focused field or button is gone and focus falls back to <body>,
// in front of the skip link. Before a guarded form submits, remember where focus was in it;
// when the same form appears again (same page, same hidden identifiers), put focus back on
// the same field or submit button — or, if that now sits inside a closed disclosure, on the
// disclosure's summary. Nothing moves when the person has already put focus somewhere else.
//
// Framework-free so it can be tested without a browser; the DOM is passed in.

type FocusTarget = { kind: "field"; name: string } | { kind: "submit"; index: number };

type PendingRestore = {
  path: string;
  signature: string;
  ordinal: number;
  target: FocusTarget;
  expires: number;
};

// Long enough for a slow save and the page refresh that follows it.
const RESTORE_WINDOW_MS = 20_000;

let pending: PendingRestore | null = null;

function submitButtons(form: HTMLFormElement): HTMLElement[] {
  return [...form.querySelectorAll<HTMLElement>('button:not([type]), button[type="submit"], input[type="submit"]')];
}

/** What identifies a form across a re-render: its id or label and its hidden identifiers. */
export function formSignature(form: HTMLFormElement): string {
  const hidden = [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')]
    .filter((input) => input.name && !input.name.startsWith("$ACTION"))
    .map((input) => `${input.name}=${input.value}`);
  return [form.id, form.getAttribute("aria-label") ?? "", ...hidden].join("&");
}

function ordinalOf(form: HTMLFormElement, signature: string): number {
  return [...form.ownerDocument.forms].filter((other) => formSignature(other) === signature).indexOf(form);
}

/** Call as the form submits. `submitter` is the button that submitted it, if any. */
export function rememberSubmitFocus(form: HTMLFormElement, submitter: HTMLElement | null, now = Date.now()): void {
  const doc = form.ownerDocument;
  const active = doc.activeElement;
  let target: FocusTarget | null = null;
  const buttons = submitButtons(form);
  if (active && form.contains(active)) {
    const name = active.getAttribute("name");
    const index = buttons.indexOf(active as HTMLElement);
    if (index >= 0) target = { kind: "submit", index };
    else if (name) target = { kind: "field", name };
  }
  if (!target && submitter && buttons.includes(submitter)) target = { kind: "submit", index: buttons.indexOf(submitter) };
  if (!target) return;
  const signature = formSignature(form);
  pending = { path: doc.location?.pathname ?? "", signature, ordinal: ordinalOf(form, signature), target, expires: now + RESTORE_WINDOW_MS };
}

function focusable(element: HTMLElement): HTMLElement | null {
  const closed = element.closest("details:not([open])");
  if (closed) return closed.querySelector<HTMLElement>(":scope > summary");
  return element;
}

/** Call when a guarded form mounts or settles. Returns true when focus was put back. */
export function restoreSubmitFocus(form: HTMLFormElement, now = Date.now()): boolean {
  if (!pending) return false;
  const doc = form.ownerDocument;
  if (now > pending.expires || (doc.location?.pathname ?? "") !== pending.path) {
    pending = null;
    return false;
  }
  const active = doc.activeElement;
  const lost = !active || active === doc.body || active === doc.documentElement;
  if (!lost) {
    // Focus survived the save (or the person moved it): leave it alone.
    if (form.contains(active)) pending = null;
    return false;
  }
  const signature = formSignature(form);
  if (signature !== pending.signature || ordinalOf(form, signature) !== pending.ordinal) return false;
  const { target } = pending;
  const element =
    target.kind === "submit"
      ? submitButtons(form)[target.index]
      : [...form.querySelectorAll<HTMLElement>("[name]")].find((field) => field.getAttribute("name") === target.name);
  pending = null;
  const destination = element ? focusable(element) : null;
  if (!destination) return false;
  destination.focus();
  return doc.activeElement === destination;
}

/** Test seam: forget any remembered focus. */
export function resetSubmitFocus(): void {
  pending = null;
}
