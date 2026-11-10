"use client";

import * as React from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";

import { Button } from "./button";
import { Toast } from "./toast";

type CopyState = "idle" | "copying" | "copied" | "failed";

type CopyDeps = {
  writeText?: (value: string) => Promise<void>;
  onChange?: () => void;
};

// The value is used only by the clipboard call, never retained in feedback state.
export function createCopyController({ writeText, onChange }: CopyDeps) {
  let state: CopyState = "idle";
  let revision = 0;
  function set(next: CopyState) { state = next; onChange?.(); }
  return {
    getState: () => state,
    dismiss() { revision++; set("idle"); },
    async copy(value: string) {
      if (state === "copying") return;
      const attempt = ++revision;
      set("copying");
      try {
        if (!writeText) throw new Error("Clipboard unavailable");
        await writeText(value);
        if (attempt === revision) set("copied");
      } catch {
        if (attempt === revision) set("failed");
      }
    },
  };
}

export type CopyButtonProps = {
  value: string;
  successMessage?: string;
};

export function CopyButton({ value, successMessage = "Copied to clipboard." }: CopyButtonProps) {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const button = React.useRef<HTMLButtonElement>(null);
  const errorId = React.useId();
  const [copy] = React.useState(() => createCopyController({
    writeText: async (text) => {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
    },
    onChange: redraw,
  }));
  React.useEffect(() => { copy.dismiss(); }, [copy, value]);
  const state = copy.getState();
  return <div className="flex min-w-0 shrink-0 flex-col gap-2 sm:max-w-56">
    <Button ref={button} variant="secondary" aria-disabled={state === "copying" || undefined}
      className="aria-disabled:cursor-wait aria-disabled:opacity-50"
      aria-busy={state === "copying" || undefined}
      aria-describedby={state === "failed" ? errorId : undefined}
      onClick={() => { void copy.copy(value); }}>
      {state === "copied" ? <Check aria-hidden={true} className="h-4 w-4 shrink-0" /> : <Copy aria-hidden={true} className="h-4 w-4 shrink-0" />}
      {state === "copying" ? "Copying…" : state === "copied" ? "Copied" : "Copy"}
    </Button>
    {state === "failed" ? <p id={errorId} role="alert" className="flex items-start gap-2 text-sm text-danger">
      <AlertTriangle aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">Couldn’t copy. Select the value and copy it manually.</span>
    </p> : null}
    <Toast message={state === "copied" ? successMessage : null} onDismiss={() => {
      copy.dismiss();
      button.current?.focus();
    }} />
  </div>;
}
