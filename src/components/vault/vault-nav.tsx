import * as React from "react";

// The Vault area's own navigation: "About you" (/vault) and "Cards" (/vault/cards). The
// sidebar and More menu reach the Vault; this keeps both of its pages one tap apart. The
// current page carries aria-current="page", an accent bar beneath it and heavier weight, so it is
// never shown by colour alone (WCAG 1.4.1). Colour comes from the design tokens.

export type VaultPage = "identity" | "cards";

const PAGES: ReadonlyArray<{ key: VaultPage; label: string; href: string }> = [
  { key: "identity", label: "About you", href: "/vault" },
  { key: "cards", label: "Cards", href: "/vault/cards" },
];

export function VaultNav({ current }: { current: VaultPage }) {
  return (
    <nav aria-label="Vault" className="flex gap-4 border-b border-line">
      {PAGES.map((page) => {
        const active = page.key === current;
        return (
          <a
            key={page.key}
            href={page.href}
            aria-current={active ? "page" : undefined}
            className={[
              "-mb-px inline-flex min-h-11 items-center border-b-2 px-1 text-sm",
              active
                ? "border-accent font-semibold text-fg"
                : "border-transparent font-medium text-fg-muted hover:text-fg",
            ].join(" ")}
          >
            {page.label}
          </a>
        );
      })}
    </nav>
  );
}
