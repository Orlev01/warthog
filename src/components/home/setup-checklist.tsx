import * as React from "react";
import { CheckCircle, Circle } from "lucide-react";

import type { SetupChecklistItem } from "@/domain/home/checklist";

// SetupChecklist — the home dashboard's first-run set-up checklist (brief
// design_ux "HOME — a set-up checklist"). This is PURELY a renderer: it draws
// EXACTLY the items it is given, in order — the five labels, links and the
// "done" rule all live in the ONE pure module @/domain/home/checklist, so this
// component hard-codes nothing. Any page heading or progress summary is the
// caller's job, not this one.
//
// Each item shows its done / not-done state in WORDS plus an ICON (an <svg>),
// never by colour alone (brief design_ux.feel + CLAUDE.md: "status uses words +
// icons, never colour alone"). The icon is decorative (aria-hidden) so a screen
// reader announces the state words, which sit ALONGSIDE the link rather than
// inside the link text. Colour comes from the design tokens (globals.css).

export type SetupChecklistProps = {
  // The already-computed items (@/domain/home/checklist). Rendered as given.
  items: ReadonlyArray<SetupChecklistItem>;
};

export function SetupChecklist({ items }: SetupChecklistProps) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.href}
          className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface p-3"
        >
          <a className="font-medium text-accent hover:text-accent-hover" href={item.href}>
            {item.label}
          </a>
          <ChecklistState done={item.done} />
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
    <span className={["inline-flex items-center gap-1.5 text-sm font-medium", tone].join(" ")}>
      <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
      {label}
    </span>
  );
}
