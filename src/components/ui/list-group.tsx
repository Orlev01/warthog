import * as React from "react";
import { ChevronDown } from "lucide-react";

// A titled group in a grouped list: a heading with its count, an optional one-line
// summary, and the group's rows (divider rows, not a card per item). `collapsible` renders
// it as a native disclosure for groups a person rarely needs open (Done, Paused, History,
// Later); `defaultOpen` opens it. The heading level is the caller's, so groups nest under
// whatever heading the page already has.

type HeadingLevel = 2 | 3 | 4;

export function ListGroup({
  id,
  title,
  count,
  summary,
  level = 2,
  collapsible = false,
  defaultOpen = false,
  ordered = false,
  children,
}: {
  id: string;
  title: React.ReactNode;
  count?: number;
  summary?: React.ReactNode;
  level?: HeadingLevel;
  collapsible?: boolean;
  defaultOpen?: boolean;
  ordered?: boolean;
  children: React.ReactNode;
}) {
  const Heading = `h${level}` as "h2" | "h3" | "h4";
  const headingId = `${id}-heading`;
  const countBadge =
    count !== undefined ? (
      <span className="rounded-card bg-surface-muted px-2 py-0.5 text-xs font-medium tabular-nums text-fg-muted">{count}</span>
    ) : null;
  const List = ordered ? "ol" : "ul";
  const rows = (
    <List role="list" className="flex flex-col">
      {children}
    </List>
  );

  if (collapsible) {
    return (
      <section aria-labelledby={headingId} className="flex min-w-0 flex-col">
        <details open={defaultOpen} className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-field focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            <Heading id={headingId} className="text-base font-semibold text-fg">
              {title}
            </Heading>
            {countBadge}
            <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
          </summary>
          {summary ? <p className="text-sm text-fg-muted">{summary}</p> : null}
          {rows}
        </details>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Heading id={headingId} className={level === 2 ? "text-lg font-semibold text-fg" : "text-base font-semibold text-fg"}>
          {title}
        </Heading>
        {countBadge}
      </div>
      {summary ? <p className="text-sm text-fg-muted">{summary}</p> : null}
      {rows}
    </section>
  );
}

// One divider row inside a ListGroup.
export const LIST_ROW = "flex min-w-0 flex-col gap-1 border-b border-line py-3 last:border-0 [overflow-wrap:anywhere]";
