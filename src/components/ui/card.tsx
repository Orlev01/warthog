import * as React from "react";

// Card — a raised surface container with a subtle border (technical-design §11),
// built on the design tokens. Colour and radius come from tokens, never raw hex.

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, children, ...props }: CardProps) {
  return (
    <div
      className={["wh-card rounded-card border border-line bg-surface p-4", className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
