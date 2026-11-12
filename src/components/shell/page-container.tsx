import * as React from "react";

// The outer page owns gutters, the vertical rhythm between its panels (16px phone, 24px from
// 640px) and the page width. Inside the signed-in shell the width comes from the section
// family (workspace-navigation.ts pageMeasureFor → AppShell data-measure), so sibling route
// tabs never move the page's left edge and the chrome above shares it; `size` is the fallback
// outside a section family. Form fields keep their narrower local measure.
//
// `aside`: supporting content (evidence, filters, a local index) that sits in a 320px column
// beside the main content from 1600px wide, and after it — in reading order — below that.
export function PageContainer({
  children,
  className,
  size = "reading",
  aside,
  asideLabel,
}: {
  children: React.ReactNode;
  className?: string;
  size?: "reading" | "wide" | "form";
  aside?: React.ReactNode;
  asideLabel?: string;
}) {
  const classes = [
    "wh-page",
    size === "wide" ? "" : `wh-page--${size}`,
    aside ? "wh-page--with-aside" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  if (!aside) return <div className={classes}>{children}</div>;
  return (
    <div className={classes}>
      <div className="wh-page-main">{children}</div>
      <aside aria-label={asideLabel} className="wh-page-aside">
        {aside}
      </aside>
    </div>
  );
}
export default PageContainer;
