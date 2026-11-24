import * as React from "react";
import { CheckCircle, ChevronRight, Circle } from "lucide-react";

import type { SetupChecklistItem } from "@/domain/home/checklist";

// SetupChecklist — the home dashboard's first-run set-up checklist (brief
// design_ux "HOME — a set-up checklist"). This is PURELY a renderer: it draws
// EXACTLY the items it is given, in order — the five labels, links and the
// "done" rule all live in the ONE pure module @/domain/home/checklist, so this
// component hard-codes nothing. Any page heading or progress summary is the
// caller's job, not this one.
//
// Each step is one obviously actionable row (UI/UX pass, newcomer-01): the whole row is
// the link, at least 48px tall, with the step underlined like a link and a chevron at its
// end, so it reads as "go and do this" rather than a report. Rows are divided by rules;
// from tablet width they flow into two columns so a full-width panel doesn't stretch a
// row across the screen.
//
// Each item shows its done / not-done state in WORDS plus an ICON (an <svg>),
// never by colour alone (brief design_ux.feel + CLAUDE.md: "status uses words +
// icons, never colour alone"). The icons are decorative (aria-hidden) so a screen
// reader announces the step and then its state words. Colour comes from the design
// tokens (globals.css).

export type SetupChecklistProps = {
  // The already-computed items (@/domain/home/checklist). Rendered as given.
  items: ReadonlyArray<SetupChecklistItem>;
};

export function SetupChecklist({ items }: SetupChecklistProps) {
  return (
    <ul role="list" className="grid min-w-0 grid-cols-1 md:grid-cols-2 md:gap-x-8">
      {items.map((item) => (
        <li
          key={item.href}
          className="min-w-0 border-t border-line first:border-t-0 md:[&:nth-child(2)]:border-t-0"
        >
          <a
            href={item.href}
            className="group flex min-h-12 min-w-0 items-center gap-3 py-2 text-sm text-fg"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium underline decoration-line-strong underline-offset-4 [overflow-wrap:anywhere] group-hover:decoration-current">
                {item.label}
              </span>
              {item.note ? <span className="text-sm text-fg-muted">{item.note}</span> : null}
            </span>
            <span className="sr-only">: </span>
            <ChecklistState done={item.done} />
            <ChevronRight aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted group-hover:text-fg" />
          </a>
        </li>
      ))}
    </ul>
  );
}

// The completion state of one item, shown as words + a decorative icon. A done
// item reads "Done"; a not-done item reads "To do". Colour comes from tone
// tokens; the icon inherits it via currentColor.
function ChecklistState({ done }: { done: boolean }) {
  const { label, Icon, tone } = done
    ? { label: "Done", Icon: CheckCircle, tone: "text-success" }
    : { label: "To do", Icon: Circle, tone: "text-fg-muted" };
  return (
    <span className={["inline-flex shrink-0 items-center gap-1.5 text-sm font-medium", tone].join(" ")}>
      <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
      {label}
    </span>
  );
}
