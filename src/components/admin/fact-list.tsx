import * as React from "react";

// FactList — a few named facts in a muted inset (docs/design/admin-portal.md §5), over the
// workspace's existing `wh-evidence-facts` definition-list treatment (20px tabular values).

export type Fact = { key: string; label: string; value: React.ReactNode };

export function FactList({ facts, label }: { facts: readonly Fact[]; label?: string }) {
  return (
    <dl className="wh-evidence-facts wh-fact-list" aria-label={label}>
      {facts.map((fact) => (
        <div key={fact.key}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
