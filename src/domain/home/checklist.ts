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
  readonly profileBuilt?: boolean; // "Build your profile" done
  // Things an agent found that wait for the person to check (records and About you details): shown
  // on "Build your profile" while it isn't done.
  readonly profileWaiting?: number;
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
  // A short status beside the item, in words ("12 waiting for you to check").
  readonly note?: string;
};

// "Build your profile" (docs/adr/profile-build.md): the block the step's row leads to. On Home while
// the step is to do; once it's done, the permanent one on Life admin's Add tab (the prompt can be run
// again any time to fill gaps), since Home no longer shows it.
export const BUILD_PROFILE_ANCHOR = "build-profile";
export const BUILD_PROFILE_HOME_HREF = `/home#${BUILD_PROFILE_ANCHOR}`;
export const BUILD_PROFILE_LIFE_ADMIN_HREF = `/life-admin?tab=add#${BUILD_PROFILE_ANCHOR}`;

// The five first-run items, in documented order: label, link, and the signal
// that marks it done. This table fixes the items for every consumer. The order is
// the order a newcomer should do them in (UI/UX pass, newcomer-01): connecting an
// agent is what makes Warthog work, so it comes first and goes straight to the
// connect guide; a card is optional and sensitive, so it comes last. "Build your profile" (founder,
// 24 Nov 2026; docs/adr/profile-build.md) replaced "Add your details": the person's agent fills in
// Life admin and suggests About you details from what it can read, and the person checks them.
const ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly href: string;
  readonly signal: "agentConnected" | "serviceConnected" | "profileBuilt" | "notificationsEnabled" | "cardAdded";
}> = [
  { label: "Connect an agent", href: "/agents/connect", signal: "agentConnected" },
  { label: "Connect a service", href: "/connectors", signal: "serviceConnected" },
  { label: "Build your profile", href: BUILD_PROFILE_HOME_HREF, signal: "profileBuilt" },
  { label: "Get notified", href: "/settings/notifications", signal: "notificationsEnabled" },
  { label: "Add a card", href: "/vault/cards", signal: "cardAdded" },
];

// Build the five first-run checklist items for the given account state. Labels
// and links are fixed; only `done` varies — an item is done iff its own signal
// is truthy.
export function computeSetupChecklist(signals: SetupSignals): SetupChecklistItem[] {
  return ITEMS.map(({ label, href, signal }) => {
    const done = signals[signal] === true;
    const waiting = signal === "profileBuilt" && !done ? signals.profileWaiting ?? 0 : 0;
    // Once the profile is built, Home's block is gone: the row leads to the one on Life admin.
    const to = signal === "profileBuilt" && done ? BUILD_PROFILE_LIFE_ADMIN_HREF : href;
    return { label, href: to, done, ...(waiting > 0 ? { note: `${waiting} waiting for you to check` } : {}) };
  });
}
