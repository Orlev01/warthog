import * as React from "react";
import { TriangleAlert } from "lucide-react";

import { CopyButton } from "@/components/ui/copy-button";

// A newly issued access key, shown ONCE: the key verbatim (selectable, wrapping rather than
// overflowing), the shared Copy control with its clipboard instruction, and the warning that
// it won't be shown again. The creation flow (`access-key-flow.tsx`) and the agent's
// "Access key" panel (`access-key-panel.tsx`, after Replace or Create a new key) both show a
// key through this one piece, so the handling and the words never drift apart. Both are
// client components, as the Copy control needs the clipboard.

// The copy toast stays until dismissed (a custom message), because it carries an instruction.
export const ACCESS_KEY_COPIED = "Access key copied. Paste it into your agent, then clear your clipboard.";

export function IssuedKey({ keyValue }: { keyValue: string }) {
  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="block min-w-0 flex-1 select-all overflow-x-auto rounded-field bg-surface-muted px-3 py-2 font-mono text-sm text-fg [overflow-wrap:anywhere]">
          {keyValue}
        </code>
        <CopyButton value={keyValue} label="access key" successMessage={ACCESS_KEY_COPIED} />
      </div>
      <p className="inline-flex items-start gap-2 text-sm font-medium text-warning">
        <TriangleAlert aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0" />
        Copy it now — for your security this key won&rsquo;t be shown again.
      </p>
    </>
  );
}
