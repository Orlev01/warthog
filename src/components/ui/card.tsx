import * as React from "react";

// Card — a raised surface container with a subtle border (technical-design §11),
// built on the design tokens. Colour and radius come from tokens, never raw hex. Inside the
// workspace it takes the panel depth (14px, edge, shadow) at the panel's padding (16px phone,
// 20px from 640px); nested inside another panel it becomes a muted inset (surfaces.css).

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, children, ...props }: CardProps) {
  return (
    <div
      className={["wh-card rounded-card border border-line bg-surface p-4 sm:p-5", className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
