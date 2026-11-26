"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Badge, CountBadge } from "@/components/ui/badge";

// One card in the Skills library, the same for the person's own skills and plugins and for
// Warthog's: the whole card is one button that opens the skill's editor. It shows the name and
// what kind it is, the "use this when" line, and a footer of short facts in words (never colour
// alone), ending "Open & edit".
export function LibraryCard({
  icon: Icon,
  name,
  kind,
  notes,
  description,
  facts,
  opening = false,
  busy = false,
  onOpen,
}: {
  icon: LucideIcon;
  name: string;
  // What it is, as a badge: "Skill", "Plugin" or "Warthog".
  kind: string;
  // Badges that need the person, after the kind (e.g. "Warthog updated this").
  notes?: React.ReactNode;
  description: string;
  facts: readonly string[];
  // This card's editor is loading.
  opening?: boolean;
  // Another card's editor is loading.
  busy?: boolean;
  onOpen: (opener: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      className="wh-card flex h-full min-h-44 w-full flex-col gap-3 rounded-card border border-line bg-surface p-4 text-start transition-colors hover:border-line-strong"
      aria-disabled={busy || opening}
      aria-busy={opening}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <span className="flex min-w-0 items-start gap-3">
          <Icon aria-hidden className="mt-1 h-5 w-5 shrink-0 text-accent" />
          <span className="font-semibold [overflow-wrap:anywhere]">{name}</span>
        </span>
        <span className="flex shrink-0 flex-wrap justify-end gap-2">
          {notes}
          <Badge className="shrink-0">{kind}</Badge>
        </span>
      </div>
      <p className="text-sm leading-relaxed text-fg-muted [overflow-wrap:anywhere]">{description}</p>
      <div className="mt-auto flex w-full flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 text-xs text-fg-muted">
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
        <span className="ms-auto text-sm font-medium text-fg">Open &amp; edit →</span>
      </div>
    </button>
  );
}

// A heading over a run of library cards: the title, how many there are, and one line saying
// what they are. Level 2 for a section of the library, 3 for a group inside it.
export function LibraryHeading({
  id,
  title,
  count,
  summary,
  level = 2,
}: {
  id: string;
  title: string;
  count?: number;
  summary?: string;
  level?: 2 | 3;
}) {
  const Heading = `h${level}` as "h2" | "h3";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <Heading id={id} className={level === 2 ? "text-lg font-semibold text-fg" : "text-base font-semibold text-fg"}>
          {title}
        </Heading>
        {count !== undefined ? <CountBadge count={count} /> : null}
      </div>
      {summary ? <p className="text-sm text-fg-muted">{summary}</p> : null}
    </div>
  );
}
