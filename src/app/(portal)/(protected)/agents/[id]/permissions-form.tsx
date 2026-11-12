"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Notice as InlineNotice } from "@/components/ui/notice";

import {
  PermissionsView,
  type PermissionsViewProps,
} from "@/components/agents/permissions-view";
import {
  DEFAULT_CARD_BUDGET,
  type Budget,
  type PeriodKind,
} from "@/domain/budget/budget";
import type { PermissionsSaveInput, SaveResult } from "./actions";
import { collectEdits } from "./permission-edits";

// E10-S08 — the LIVE per-agent permissions form (the client leg that wires the shaping
// screen to the tested save action).
//
// PermissionsView (E10-S07) is the pure, prop-driven SHAPING screen, but its controls
// are uncontrolled native inputs with no `name` and its "Save changes" button is a
// `type="button"` with no handler — so a plain server `<form action>` around it can never
// submit (the save action would be a dead control). As the sibling FactorControls
// (E04-S37) does for the security screen's dead controls, this thin CLIENT component makes
// that one screen live: it mounts PermissionsView and drives the already-tested `save`
// server action (passed as a prop — the only callable a server page can hand across the
// client boundary), reporting every outcome in plain words (never failing silently).
//
// It reads the person's edits off the rendered controls by their stable `name` attribute
// (review fix W2.3: never by visible label text, which a service or skill name could
// collide with) and mirrors card access and its budget back into PermissionsView's props so
// the budget field appears when card access is switched on and the save control enables
// once a budget is entered. The server still resolves the agent member-scoped and enforces
// the card-needs-budget invariant (and validates every field, and grants only the person's
// own connected services), so this client mirror is convenience, never the authority.

// The plain-words outcome of the last save — words plus an icon, never colour alone.
type Notice = { readonly tone: "done" | "problem"; readonly text: string };

const SAVED: Notice = {
  tone: "done",
  text: "Saved. The change takes effect on this agent's next request.",
};

// A refused save, in plain Australian English (never a raw machine code or protocol
// jargon). An unknown reason falls back to the generic invalid-request copy.
const INVALID: Notice = {
  tone: "problem",
  text: "Nothing was changed: that request wasn't valid. Please check and try again.",
};

const PROBLEM: Record<string, Notice> = {
  disconnected: {
    tone: "problem",
    text: "This agent is disconnected. Connect it again before changing access.",
  },
  not_found: {
    tone: "problem",
    text: "Nothing was changed: that agent is no longer on your account.",
  },
  card_needs_budget: {
    tone: "problem",
    text: "Nothing was changed: add a budget before you can switch on card access.",
  },
  invalid_request: INVALID,
  form_incomplete: {
    tone: "problem",
    text: "Nothing was saved: this screen couldn't read all of your settings. Please reload the page and try again.",
  },
};

function problemNotice(reason: string): Notice {
  return PROBLEM[reason] ?? INVALID;
}

// The accessible name of a control — the text of its associated <label>, or its
// aria-label — carried on each snapshot for diagnostics only; the save matches on `name`.
function labelText(el: HTMLInputElement): string {
  const labels = el.labels;
  const first = labels && labels.length > 0 ? labels[0] : null;
  return (first?.textContent ?? el.getAttribute("aria-label") ?? "").trim();
}

// The outcome banner: a problem is announced immediately (alert), a success politely
// (status). Colour comes from the design tokens — never a raw hex.
function NoticeBanner({ notice }: { notice: Notice }) {
  return (
    <InlineNotice tone={notice.tone === "done" ? "success" : "error"}>
      {notice.text}
    </InlineNotice>
  );
}

export interface PermissionsFormProps {
  // the screen's data, as the loader assembled it (the agent named, its stored grants).
  readonly initial: PermissionsViewProps;
  // the screen's save server action, bound to this agent id by the page.
  readonly save: (input: PermissionsSaveInput) => Promise<SaveResult>;
}

export function PermissionsForm({
  initial,
  save,
}: PermissionsFormProps): React.ReactElement {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  // Card access and its amount are mirrored into state so the view reflects an edit live:
  // switching card on reveals the budget field, and entering a budget enables the save
  // control. Every other control stays uncontrolled and is read from the DOM on save.
  const [cardOn, setCardOn] = React.useState(initial.cardAccess);
  const [budgetAmount, setBudgetAmount] = React.useState<number | null>(
    initial.budget?.amount ?? null,
  );
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const pendingRef = React.useRef(false);

  // Use the stored period as the initial value. The save reads the edited select.
  // Mirror the amount into state so card access can require a valid budget.
  const period: PeriodKind =
    initial.budget?.period ?? DEFAULT_CARD_BUDGET.period;
  const budget: Budget | null =
    budgetAmount != null ? { amount: budgetAmount, period } : initial.budget;

  // React handlers participate in hydration event replay. A native listener installed
  // by an effect could miss a fast save immediately after paging or navigation.
  // Mirror the two live controls into state as the person edits them.
  function onEdit(event: React.ChangeEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type === "checkbox" && target.name === "card") {
      setCardOn(target.checked);
    } else if (target.type === "number" && target.name === "cardBudget") {
      setBudgetAmount(target.value.trim() === "" ? null : Number(target.value));
    }
  }

  // Gather the current edits off the rendered controls and drive the save action.
  async function submit(): Promise<void> {
    if (pendingRef.current) return;
    const root = containerRef.current;
    if (!root) return;

    // Every control on the screen is carried with its explicit on/off state; a control the
    // form cannot find refuses the save rather than silently dropping that edit.
    const snapshot = Array.from(
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "input, select",
      ),
    ).map((i) => ({
      type: i.type,
      name: i.name,
      label: i instanceof HTMLInputElement ? labelText(i) : "",
      checked: i instanceof HTMLInputElement ? i.checked : false,
      value: i.value,
    }));
    const collected = collectEdits(snapshot, {
      currency: initial.currency ?? "A$",
      period,
      // Every connected service the screen shows carries a toggle the save must find.
      connectors: initial.connectors.map((connector) => connector.id),
      skills: initial.skills.map((skill) => skill.id),
      memories: initial.memories?.map((m) => m.id),
      vaultFields: initial.vaultFields?.map((f) => f.id),
      section: initial.section ?? "all",
    });
    if (!collected.ok) {
      setNotice(problemNotice(collected.reason));
      return;
    }
    const input: PermissionsSaveInput = collected.input;

    pendingRef.current = true;
    setSaving(true);
    try {
      const result = await save(input);
      if (result.ok) {
        setNotice(SAVED);
        // Re-run the loader so the screen reflects the persisted grants.
        router.refresh();
      } else {
        setNotice(problemNotice(result.reason));
      }
    } catch {
      // A boundary 4xx (or any transport fault) is reported, never swallowed.
      setNotice(problemNotice("invalid_request"));
    } finally {
      pendingRef.current = false;
      setSaving(false);
    }
  }

  // The view's "Save changes" button is a type="button" with no handler, marked
  // data-action="save"; a click on it (it never fires while the button is disabled)
  // drives the save. Any other click (a toggle, the Advanced summary) is left to its
  // native behaviour.
  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    const node =
      event.target instanceof Element ? event.target.closest("button") : null;
    if (!node || node.getAttribute("data-action") !== "save") return;
    event.preventDefault();
    void submit();
  }

  return (
    <div
      ref={containerRef}
      onChange={onEdit}
      onClick={onClick}
      className="flex flex-col gap-4 sm:gap-6"
    >
      <fieldset
        disabled={!ready}
        aria-busy={!ready}
        className="m-0 min-w-0 border-0 p-0"
      >
        <PermissionsView
          {...initial}
          saving={saving}
          cardAccess={cardOn}
          budget={budget}
        />
      </fieldset>
      {/* The outcome sits under the Save bar it answers, where the person's attention is
          after a long section, rather than off-screen at the top. */}
      {notice ? <NoticeBanner notice={notice} /> : null}
    </div>
  );
}

export default PermissionsForm;
