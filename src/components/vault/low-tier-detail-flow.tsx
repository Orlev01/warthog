"use client";

import * as React from "react";
import { Plus, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Label } from "@/components/ui/field";
import { SELECT_CLASS } from "@/components/ui/select";
import type { LowTierFieldKind } from "./identity-view";

// Review fix G1 — add and edit an everyday ("low-tier") detail on the Vault "About you"
// screen (brief "Identity vault", primary journey flow 2 "About you"; design §4.1 low
// tier). Low-tier details are DEK-encrypted on the server, so — unlike a high-tier detail —
// the plaintext value is what the page's server action receives.
//
// The repo's render-testable-AND-interactive split (HighTierFlow + createHighTierFlow):
//   1. LowTierDetailFlow — the Client Component <IdentityView/> mounts. ADD mode: closed it
//      is a live "Add a detail" control; open it is a kind picker, a value field (plus a
//      moving-on date for a postal address) and Save. EDIT mode: one existing field's value
//      (and an address's moving-on date) as named controls with Save.
//   2. createLowTierDetailFlow(deps) — the framework-free controller behind Save: it trims
//      and checks the value, calls the page's saveLowTierField / updateLowTierField action
//      with exactly the person's input, guards against a double submit, and reports every
//      outcome in plain words (never a raw machine reason).
//
// Colour comes from the design tokens (globals.css) — never a raw hex.

export type LowTierDetailMode = "add" | "edit";
export type LowTierDetailStatus = "idle" | "working" | "saved" | "error";

export interface LowTierDetailState {
  kind: LowTierFieldKind;
  value: string;
  // The moving-on date as the "YYYY-MM-DD" a date input holds ("" when none).
  movingOn: string;
  status: LowTierDetailStatus;
  error?: string;
}

// The existing field an EDIT flow re-saves.
export interface EditableLowTierField {
  id: string;
  kind: LowTierFieldKind;
  value: string;
  movingOn: string | Date | null;
}

// The page's server actions (vault/page.tsx wraps createIdentityActions).
export type SaveLowTierFieldAction = (input: {
  kind: LowTierFieldKind;
  value: string;
  movingOn?: string | null;
}) => Promise<{ ok: boolean; reason?: string }>;

export type UpdateLowTierFieldAction = (input: {
  fieldId: string;
  value: string;
  movingOn?: string | null;
}) => Promise<{ ok: boolean; reason?: string }>;

export interface LowTierDetailFlowDeps {
  readonly mode: LowTierDetailMode;
  readonly field?: EditableLowTierField;
  readonly saveLowTierField?: SaveLowTierFieldAction;
  readonly updateLowTierField?: UpdateLowTierFieldAction;
  readonly onChange?: () => void;
  readonly onSaved?: () => void;
}

export interface LowTierDetailController {
  getState(): LowTierDetailState;
  setKind(kind: LowTierFieldKind): void;
  setValue(value: string): void;
  setMovingOn(value: string): void;
  submit(): Promise<void>;
}

// The eight everyday kinds in the order the picker offers them, with their plain labels
// (Australian English, no jargon).
export const LOW_TIER_KIND_LABELS: ReadonlyArray<readonly [LowTierFieldKind, string]> = [
  ["name", "Name"],
  ["preferred_name", "Preferred name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["postal_address", "Postal address"],
  ["language", "Language"],
  ["time_zone", "Time zone"],
  ["preference", "Preference"],
];

// Mirrors the server's bound (vault/actions.ts VALUE_MAX), so an oversized value is
// explained here rather than refused as a bare invalid request.
const VALUE_MAX = 4096;

const EMPTY_COPY = "Type the detail before saving.";
const TOO_LONG_COPY = "That detail is too long. Please shorten it and try again.";
const SAVE_FAILED_COPY = "We couldn't save your detail just now. Please try again.";

// A stored moving-on date as a date input's "YYYY-MM-DD" ("" when absent).
function isoDate(value: string | Date | null | undefined): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

export function createLowTierDetailFlow(deps: LowTierDetailFlowDeps): LowTierDetailController {
  let state: LowTierDetailState = {
    kind: deps.field?.kind ?? "name",
    value: deps.field?.value ?? "",
    movingOn: isoDate(deps.field?.movingOn),
    status: "idle",
  };

  function set(patch: Partial<LowTierDetailState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function send(value: string): Promise<{ ok: boolean; reason?: string }> {
    const isAddress = state.kind === "postal_address";
    const movingOn = state.movingOn === "" ? null : state.movingOn;
    if (deps.mode === "edit") {
      if (!deps.updateLowTierField || !deps.field) throw new Error("no update action is wired");
      return deps.updateLowTierField({
        fieldId: deps.field.id,
        value,
        ...(isAddress ? { movingOn } : {}),
      });
    }
    if (!deps.saveLowTierField) throw new Error("no save action is wired");
    return deps.saveLowTierField({
      kind: state.kind,
      value,
      // A moving-on date belongs only to a postal address; a new detail without one
      // simply omits it.
      ...(isAddress && movingOn !== null ? { movingOn } : {}),
    });
  }

  async function submit(): Promise<void> {
    if (state.status === "working") return; // a double Save never stores a second copy
    const value = state.value.trim();
    if (value.length === 0) {
      set({ status: "error", error: EMPTY_COPY });
      return;
    }
    if (value.length > VALUE_MAX) {
      set({ status: "error", error: TOO_LONG_COPY });
      return;
    }
    set({ status: "working", error: undefined });

    let result: { ok: boolean; reason?: string };
    try {
      result = await send(value);
    } catch {
      set({ status: "error", error: SAVE_FAILED_COPY });
      return;
    }
    if (!result.ok) {
      set({ status: "error", error: SAVE_FAILED_COPY });
      return;
    }
    // ADD clears the form for the next detail; EDIT keeps the saved value on screen.
    set(
      deps.mode === "add"
        ? { status: "saved", error: undefined, value: "", movingOn: "" }
        : { status: "saved", error: undefined, value },
    );
    deps.onSaved?.();
  }

  return {
    getState: () => state,
    setKind: (kind) => set({ kind, status: "idle", error: undefined }),
    setValue: (value) => set({ value, status: state.status === "working" ? "working" : "idle" }),
    setMovingOn: (movingOn) => set({ movingOn, status: state.status === "working" ? "working" : "idle" }),
    submit,
  };
}

// ─── the client component (a thin binding over the controller) ─────────────────────────

export interface LowTierDetailFlowProps {
  mode: LowTierDetailMode;
  // EDIT mode: the existing field and its plain label ("Email", "Postal address", …).
  field?: EditableLowTierField;
  label?: string;
  saveLowTierField?: SaveLowTierFieldAction;
  updateLowTierField?: UpdateLowTierFieldAction;
  // ADD mode: whether the add form starts open (defaults to closed).
  initialOpen?: boolean;
}

export function LowTierDetailFlow(props: LowTierDetailFlowProps): React.ReactElement {
  const [open, setOpen] = React.useState<boolean>(props.mode === "edit" || (props.initialOpen ?? false));
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<LowTierDetailController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createLowTierDetailFlow({
      mode: props.mode,
      field: props.field,
      saveLowTierField: props.saveLowTierField,
      updateLowTierField: props.updateLowTierField,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const kindId = React.useId();
  const isAdd = props.mode === "add";
  const isAddress = state.kind === "postal_address";
  const working = state.status === "working";

  if (!open) {
    return (
      <div className="flex">
        <Button variant="secondary" type="button" onClick={() => setOpen(true)}>
          <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
          Add a detail
        </Button>
      </div>
    );
  }

  const form = (
    <form
      className="flex flex-col gap-3"
      aria-label={isAdd ? "Add a detail" : `Edit ${props.label ?? "detail"}`}
      onSubmit={(event) => {
        event.preventDefault();
        void flow.submit();
      }}
    >
      {isAdd ? (
        <>
          <h3 className="text-sm font-semibold text-fg">Add a detail</h3>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={kindId}>What kind of detail?</Label>
            <select
              id={kindId}
              name="kind"
              className={SELECT_CLASS}
              value={state.kind}
              onChange={(event) => flow.setKind(event.target.value as LowTierFieldKind)}
            >
              {LOW_TIER_KIND_LABELS.map(([kind, kindLabel]) => (
                <option key={kind} value={kind}>
                  {kindLabel}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : null}
      <Field
        label={isAdd ? "The detail" : (props.label ?? "Detail")}
        name="value"
        value={state.value}
        maxLength={VALUE_MAX}
        error={state.status === "error" ? state.error : undefined}
        onChange={(event) => flow.setValue(event.target.value)}
      />
      {isAddress ? (
        <Field
          label="Moving on"
          name="movingOn"
          type="date"
          value={state.movingOn}
          onChange={(event) => flow.setMovingOn(event.target.value)}
        />
      ) : null}
      {state.status === "saved" ? (
        <p role="status" className="text-sm text-success">
          Saved.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={working}>
          <Save aria-hidden={true} className="h-4 w-4 shrink-0" />
          {working ? "Saving…" : "Save"}
        </Button>
        {isAdd ? (
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );

  return isAdd ? <Card className="flex flex-col gap-3">{form}</Card> : form;
}

export default LowTierDetailFlow;
