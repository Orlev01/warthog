// The home set-up checklist (brief design_ux "HOME — a set-up checklist", Home
// dashboard requirement) — a pure module, no React and no I/O. It is the single
// canonical definition of the five first-run items (their labels and links) and
// the one rule that decides whether each is done. The status read (E18-S04)
// produces the signals; the component (E18-S06) renders the result, so both read
// the exact five items and their links from here.

// Account state for the checklist: one optional flag per item. Each flag, when
// truthy, marks its own item done; absent or false leaves it not done. The flag
// names are the cross-task contract E18-S04 populates and E18-S06 renders.
export type SetupSignals = {
  readonly notificationsEnabled?: boolean; // "Get notified" done
  readonly identityAdded?: boolean; // "About you" done
  readonly cardAdded?: boolean; // "Add a card" done
  readonly serviceConnected?: boolean; // "Connect a service" done
  readonly agentConnected?: boolean; // "Connect an agent" done
};

// One rendered checklist item: its copy, its destination, and whether the
// account state shows it as done.
export type SetupChecklistItem = {
  readonly label: string;
  readonly href: string;
  readonly done: boolean;
};

// The five first-run items, in documented order: label, link, and the signal
// that marks it done. This table fixes the items for every consumer.
const ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly href: string;
  readonly signal: keyof SetupSignals;
}> = [
  { label: "Get notified", href: "/settings/notifications", signal: "notificationsEnabled" },
  { label: "About you", href: "/vault", signal: "identityAdded" },
  { label: "Add a card", href: "/vault/cards", signal: "cardAdded" },
  { label: "Connect a service", href: "/connectors", signal: "serviceConnected" },
  { label: "Connect an agent", href: "/agents", signal: "agentConnected" },
];

// Build the five first-run checklist items for the given account state. Labels
// and links are fixed; only `done` varies — an item is done iff its own signal
// is truthy.
export function computeSetupChecklist(signals: SetupSignals): SetupChecklistItem[] {
  return ITEMS.map(({ label, href, signal }) => ({
    label,
    href,
    done: signals[signal] === true,
  }));
}
