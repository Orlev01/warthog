import * as React from "react";

import { buttonClasses, buttonWidthAttribute, type ButtonSize, type ButtonVariant, type ButtonWidth } from "./button";

// ButtonLink — a navigation link that looks like a Button (same variants, sizes, focus and
// forced-colours boundary). Use it for "Create an access key", "Back to agents" and every
// other link that is styled as an action, instead of hand-rolling the classes. It stays a
// real <a href>, so it opens in a new tab, shows its URL and needs no client JavaScript.
// Links default to `secondary`: the screen's one `primary` is normally its submit button.

export type ButtonLinkProps = React.ComponentPropsWithRef<"a"> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: ButtonWidth;
};

export function ButtonLink({ variant = "secondary", size = "md", width = "auto", className, children, ...props }: ButtonLinkProps) {
  return (
    <a className={buttonClasses({ variant, size, width, className })} {...buttonWidthAttribute(width)} {...props}>
      {children}
    </a>
  );
}
