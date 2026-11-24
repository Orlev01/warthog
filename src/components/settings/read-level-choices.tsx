"use client";

import * as React from "react";

import { Notice } from "@/components/ui/notice";
import { OPEN_LEVEL_WARNING, READ_LEVELS, type ReadLevel } from "@/domain/content/read-levels";

// Settings › Agent defaults — the person's "what agents see" level (docs/adr/read-side-protection.md,
// amendment 24 November 2026): three choices, each with its one plain line, in the same option
// cards as the consent screen's starting sets. Choosing Everything shows a short warning before
// they save. The panel's form posts the chosen `readLevel`; nothing is saved until they do.
export function ReadLevelChoices({ level }: { level: ReadLevel }) {
  const [chosen, setChosen] = React.useState<ReadLevel>(level);
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="wh-permission-presets">
        <legend className="sr-only">What agents see</legend>
        {READ_LEVELS.map((choice) => (
          <label key={choice.value} data-selected={chosen === choice.value}>
            <span>
              <input type="radio" name="readLevel" value={choice.value} checked={chosen === choice.value} onChange={() => setChosen(choice.value)} />
              <strong>{choice.recommended ? `${choice.label} (recommended)` : choice.label}</strong>
            </span>
            <span>{choice.description}</span>
          </label>
        ))}
      </fieldset>
      {chosen === "open" ? <Notice tone="warning">{OPEN_LEVEL_WARNING}</Notice> : null}
      <p className="text-sm text-fg-muted">
        Whatever you choose, Warthog removes hidden text and tells agents that what they read was written by someone else.
      </p>
    </div>
  );
}
