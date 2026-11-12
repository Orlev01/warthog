import * as React from "react";
import type { LucideIcon } from "lucide-react";

/** Presentation only: one heading per page and one surface per meaningful group. */
export function WorkspaceHeading({
  eyebrow,
  title,
  description,
  meta,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  description?: string;
  // A short live summary under the description, e.g. "3 agents · 1 needs reconnecting".
  meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="wh-page-heading">
      <div className="min-w-0">
        <p className="wh-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="wh-page-description">{description}</p>}
        {meta ? <p className="mt-2 text-sm font-medium text-fg">{meta}</p> : null}
      </div>
      {children && <div className="wh-heading-actions">{children}</div>}
    </header>
  );
}

export function WorkspacePanel({
  title,
  description,
  icon: Icon,
  action,
  children,
  className = "",
  headingLevel = 2,
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const id = React.useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={id} className={`wh-panel ${className}`}>
      <header className="wh-panel-header">
        <span className="wh-panel-icon"><Icon aria-hidden size={18} strokeWidth={1.7} /></span>
        <div className="min-w-0 flex-1">
          <Heading id={id}>{title}</Heading>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="wh-panel-action">{action}</div>}
      </header>
      <div className="wh-panel-body">{children}</div>
    </section>
  );
}
