import * as React from "react";
import { ChevronDown } from "lucide-react";
import { CountBadge } from "./badge";

// A titled group in a grouped list: one panel whose header band holds the heading, its count
// and an optional one-line summary, followed by the group's divider rows (never a card per
// item). Placed inside another bounded surface (a WorkspacePanel, a card, a permission
// group, another ListGroup or a toolbar) it drops its own border and becomes a plain
// sub-section of that surface, so there is no card-in-card (styles: surfaces.css).
// `collapsible` renders it as a native disclosure for groups a person rarely needs open
// (Done, Paused, History, Later); `defaultOpen` opens it. The heading level is the caller's,
// so groups nest under whatever heading the page already has. Each row is an <li>; use
// LIST_ROW for its layout.

type HeadingLevel = 2 | 3 | 4;

export function ListGroup({
  id,
  title,
  count,
  summary,
  action,
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
  // One small control in the header band, e.g. a "View all" link (not for collapsible groups).
  action?: React.ReactNode;
  level?: HeadingLevel;
  collapsible?: boolean;
  defaultOpen?: boolean;
  ordered?: boolean;
  children: React.ReactNode;
}) {
  const Heading = `h${level}` as "h2" | "h3" | "h4";
  const headingId = `${id}-heading`;
  const countBadge = count !== undefined ? <CountBadge count={count} /> : null;
  const List = ordered ? "ol" : "ul";
  const rows = (
    <List role="list" className="wh-list-group-rows">
      {children}
    </List>
  );

  if (collapsible) {
    return (
      <section aria-labelledby={headingId} className="wh-list-group" data-collapsible="">
        <details open={defaultOpen} className="group">
          <summary className="wh-list-group-header wh-list-group-title">
            <Heading id={headingId}>{title}</Heading>
            {countBadge}
            <ChevronDown aria-hidden={true} className="wh-list-group-chevron h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
          </summary>
          {summary ? <p className="wh-list-group-summary">{summary}</p> : null}
          {rows}
        </details>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="wh-list-group">
      <div className="wh-list-group-header">
        <div className="wh-list-group-title">
          <Heading id={headingId}>{title}</Heading>
          {countBadge}
          {action ? <div className="wh-list-group-action">{action}</div> : null}
        </div>
        {summary ? <p className="wh-list-group-summary">{summary}</p> : null}
      </div>
      {rows}
    </section>
  );
}

// One divider row inside a ListGroup. The group supplies the row's inline padding.
export const LIST_ROW = "flex min-w-0 flex-col gap-1 border-b border-line py-3 last:border-0 [overflow-wrap:anywhere]";
