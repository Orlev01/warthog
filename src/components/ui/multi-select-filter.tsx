"use client";

import * as React from "react";
import Form from "next/form";
import { ChevronDown } from "lucide-react";

import { Button, buttonClasses } from "./button";
import { CountBadge } from "./badge";

// A multiple-choice list filter, for a ListToolbar: a native <details> whose summary says what's
// chosen ("Category: All", "Category: Vehicles", "Category: Vehicles +2") over a fieldset of
// named checkboxes, each with its count. It sits in a <FilterForm>, a plain GET form, so the
// choice lives in the address as repeated parameters (`?category=vehicles&category=health`):
// it works before (and without) JavaScript through the form's Apply button, deep-links, and
// Back/Forward restore it. With JavaScript, ticking a box applies it at once: the form navigates
// in place (keeping the scroll position), the disclosure stays open and focus stays on the box.
//
// The page validates what's in the address and passes the chosen values back as `selected`;
// the boxes follow it (after Back or Forward too). `defaults` are what applies when nothing is
// ticked, so a filter that can't be empty (a status that defaults to Active) shows its default
// ticked again instead of a choice of nothing.

export type MultiSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
};

/** "Category: All", "Category: Vehicles", "Category: Vehicles +2" — the chosen options in their order. */
export function multiSelectSummary(label: string, options: readonly MultiSelectOption[], selected: readonly string[], noneLabel = "All"): string {
  const chosen = options.filter((option) => selected.includes(option.value));
  if (chosen.length === 0) return `${label}: ${noneLabel}`;
  return `${label}: ${chosen[0]!.label}${chosen.length > 1 ? ` +${chosen.length - 1}` : ""}`;
}

export function MultiSelectFilter({
  label,
  name,
  options,
  selected,
  noneLabel = "All",
  defaults = [],
  hint,
  countLabel,
}: {
  // Names the filter: the summary's prefix and the fieldset's legend ("Category").
  label: string;
  // The GET parameter each ticked box posts ("category").
  name: string;
  options: readonly MultiSelectOption[];
  // The values the page applied (validated), ticked.
  selected: readonly string[];
  // The summary when nothing is ticked ("All").
  noneLabel?: string;
  // What applies when nothing is ticked; shown ticked instead of an empty choice.
  defaults?: readonly string[];
  // One line under the legend, e.g. "None ticked shows every category."
  hint?: string;
  // How a count is read out ("3 records"); the number alone when absent.
  countLabel?: (count: number) => string;
}) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const detailsRef = React.useRef<HTMLDetailsElement>(null);
  // The page's choice, followed whenever it changes (a navigation, Back or Forward); a tick
  // shows at once, before the page has answered.
  const applied = selected.join("\u0000");
  const [checked, setChecked] = React.useState<readonly string[]>(selected);
  React.useEffect(() => {
    setChecked(applied ? applied.split("\u0000") : []);
  }, [applied]);

  const toggle = (value: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const on = event.currentTarget.checked;
    const next = on ? [...checked.filter((v) => v !== value), value] : checked.filter((v) => v !== value);
    setChecked(next.length === 0 ? defaults : next);
    // Apply at once: the form navigates in place (next/form), keeping the scroll position.
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <details
      ref={detailsRef}
      className="group/multi min-w-0 open:basis-full"
      onKeyDown={(event) => {
        // Escape closes the choices and returns focus to the summary.
        if (event.key !== "Escape" || !detailsRef.current?.open) return;
        event.preventDefault();
        detailsRef.current.open = false;
        detailsRef.current.querySelector("summary")?.focus();
      }}
    >
      <summary className={buttonClasses({ variant: "secondary", size: "md", className: "w-fit max-w-full list-none [&::-webkit-details-marker]:hidden" })}>
        <span className="min-w-0 [overflow-wrap:anywhere]">{multiSelectSummary(label, options, checked, noneLabel)}</span>
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/multi:rotate-180" />
      </summary>
      <fieldset className="mt-2 min-w-0 rounded-card bg-surface-muted px-3 py-2" aria-describedby={hint ? hintId : undefined}>
        <legend className="sr-only">{label}</legend>
        {hint ? (
          <p id={hintId} className="px-1 pt-1 text-sm text-fg-muted">
            {hint}
          </p>
        ) : null}
        <ul role="list" className="grid min-w-0 grid-cols-1 gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
          {options.map((option) => (
            <li key={option.value} className="min-w-0">
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-field px-1 text-sm text-fg">
                <input
                  type="checkbox"
                  name={name}
                  value={option.value}
                  checked={checked.includes(option.value)}
                  onChange={toggle(option.value)}
                  className="h-4 w-4 shrink-0"
                />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option.label}</span>
                {option.count !== undefined ? <CountBadge count={option.count} label={countLabel?.(option.count)} /> : null}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </details>
  );
}

// True once the page is interactive (false while rendering on the server and hydrating), so a
// control that's only needed without JavaScript can step aside.
const subscribe = () => () => {};
function useInteractive(): boolean {
  return React.useSyncExternalStore(subscribe, () => true, () => false);
}

/**
 * The GET form a set of MultiSelectFilters sits in: it keeps the page's other state as hidden
 * values and navigates in place (next/form, scroll kept, a history entry per change). Its Apply
 * button submits the choice when there's no JavaScript; with JavaScript every box applies when
 * it's ticked, so Apply steps aside unless `apply` is "always" (a form with other kinds of
 * control that don't apply by themselves).
 */
export function FilterForm({
  action,
  label,
  hidden,
  apply = "without-script",
  children,
}: {
  action: string;
  label: string;
  hidden: Readonly<Record<string, string>>;
  apply?: "without-script" | "always";
  children: React.ReactNode;
}) {
  const interactive = useInteractive();
  return (
    <Form action={action} scroll={false} prefetch={false} aria-label={label} className="flex min-w-0 flex-wrap items-start gap-2">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      {apply === "always" || !interactive ? (
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      ) : null}
    </Form>
  );
}
