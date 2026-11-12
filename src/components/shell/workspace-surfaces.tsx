import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { HeadingScope } from "./workspace-context";

// The workspace's containment primitives (styles in src/app/surfaces.css). Every piece of
// page text sits inside one of them, never loose on the canvas: canvas → band/panel → inset,
// with divider rows inside a panel rather than a card per item. Presentation only.

// A string renders as a paragraph; richer content (several sentences, a link, a list) as a
// block so it may contain its own paragraphs.
function Copy({ className, children }: { className: string; children: React.ReactNode }) {
  return typeof children === "string" || typeof children === "number" ? (
    <p className={className}>{children}</p>
  ) : (
    <div className={className}>{children}</div>
  );
}

/**
 * The page's identity band: one per page, first inside .wh-page. Holds the optional eyebrow,
 * the h1 (24px phone / 28px desktop), a purpose line, a short live `meta` summary, one compact
 * action group (`children`), and an optional `nav` row (route tabs, a FilterLinks view switch
 * or ViewPanels' tablist) flush with the band's bottom edge. On account resource pages the
 * agent-scope row ("How access works", "Manage for one agent") appears inside the band
 * automatically; pass `scope={false}` to leave it out.
 */
export function WorkspaceHeading({
  eyebrow,
  title,
  description,
  meta,
  nav,
  scope = true,
  children,
}: {
  // Optional context above the title. Use the sidebar group name or a parent object (an
  // agent's name); never invent a grouping. Leave it out when the breadcrumb already says it.
  eyebrow?: string;
  title: React.ReactNode;
  // One sentence on what the page is for. A string renders as <p>; a node as a block.
  description?: React.ReactNode;
  // A short live summary under the description, e.g. "3 agents · 1 needs reconnecting".
  meta?: React.ReactNode;
  // A tab row or view switch that belongs to this heading, rendered last, edge to edge.
  nav?: React.ReactNode;
  scope?: boolean;
  // The page's heading actions: at most one primary plus one or two secondary controls.
  children?: React.ReactNode;
}) {
  return (
    <header className="wh-page-heading">
      <div className="wh-page-heading-main">
        <div className="wh-page-heading-text">
          {eyebrow ? <p className="wh-eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
          {description ? <Copy className="wh-page-description">{description}</Copy> : null}
          {meta ? <p className="wh-page-meta">{meta}</p> : null}
        </div>
        {children ? <div className="wh-heading-actions">{children}</div> : null}
      </div>
      {scope ? <HeadingScope /> : null}
      {nav ? <div className="wh-page-heading-nav">{nav}</div> : null}
    </header>
  );
}

/**
 * One panel per coherent task or group: a header (optional icon, title, description, one
 * action link), a body, and an optional `footer` action bar for the form's Save/Cancel and
 * its fine print. Inside, use divider rows and muted insets — never another raised card.
 */
export function WorkspacePanel({
  title,
  description,
  icon: Icon,
  action,
  footer,
  children,
  className = "",
  headingLevel = 2,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  // Rendered in a muted bar along the panel's bottom edge: form actions, a blocking warning
  // next to the disabled button, legal or explanatory fine print.
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const id = React.useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={id} className={["wh-panel", className].filter(Boolean).join(" ")}>
      <header className="wh-panel-header">
        {Icon ? (
          <span className="wh-panel-icon">
            <Icon aria-hidden size={18} strokeWidth={1.7} />
          </span>
        ) : null}
        <div className="wh-panel-title">
          <Heading id={id}>{title}</Heading>
          {description ? <Copy className="wh-panel-description">{description}</Copy> : null}
        </div>
        {action ? <div className="wh-panel-action">{action}</div> : null}
      </header>
      {children ? <div className="wh-panel-body">{children}</div> : null}
      {footer ? <footer className="wh-panel-footer">{footer}</footer> : null}
    </section>
  );
}

/**
 * A bounded action bar that closes a form spanning several panels (e.g. an agent's
 * permission sections): the submit and secondary actions, with any blocking `note` (why Save
 * is disabled) beside them. For a single-panel form use WorkspacePanel's `footer` instead.
 */
export function ActionBar({
  note,
  children,
  className,
}: {
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={["wh-form-actions", className].filter(Boolean).join(" ")}>
      <div className="wh-form-actions-buttons">{children}</div>
      {note ? <Copy className="wh-form-actions-note">{note}</Copy> : null}
    </div>
  );
}
