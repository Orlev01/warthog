import * as React from "react";

// The outer page owns gutters. Form fields keep their narrower local measure.
export function PageContainer({
  children,
  className,
  size = "reading",
}: {
  children: React.ReactNode;
  className?: string;
  size?: "reading" | "wide" | "form";
}) {
  return (
    <div
      className={[
        "wh-page",
        size === "wide" ? "" : `wh-page--${size}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
export default PageContainer;
