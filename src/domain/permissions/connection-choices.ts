import { permissionTemplate, type PermissionTemplate } from "./templates";

export type ConnectionChoices = {
  identity: boolean;
  memoryRead: boolean;
  memoryWrite: boolean;
  tasks: boolean;
  records: boolean;
  highTier: boolean;
  card: boolean;
  learningSharing: boolean;
  // The ids of the ticked connected accounts (docs/adr/several-accounts-per-agent.md).
  accounts: string[];
  cardBudget: { amount: string; period: "day" | "week" | "month" };
};

// One of the person's connected accounts, as the consent and access-key screens list it: its
// connection id, its service, and the account's own name, e.g. "levyorenbilling@gmail.com".
// Each account is its own checkbox, so an agent can be given several accounts of a service.
export type ConnectionAccount = { id: string; connectorId: string; serviceName: string; label: string; ticked?: boolean };
export type ChoiceKey = Exclude<keyof ConnectionChoices, "accounts" | "cardBudget">;

// How an account is named on these screens: "Gmail · levyorenbilling@gmail.com".
export function accountName(account: Pick<ConnectionAccount, "serviceName" | "label">): string {
  return `${account.serviceName} · ${account.label}`;
}

// Accounts are listed by service name, then by account, so a service's accounts sit together.
export function byServiceThenAccount(a: ConnectionAccount, b: ConnectionAccount): number {
  return a.serviceName.localeCompare(b.serviceName) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

// A form from a screen loaded before accounts were listed one by one: it ticks services and
// no accounts. Granting from it would give the agent nothing the person saw ticked, so the
// screen is shown again for the person to check the accounts.
export function choseServicesNotAccounts(input: { readonly accounts?: readonly string[]; readonly tickedServices?: readonly string[] }): boolean {
  return (input.tickedServices?.length ?? 0) > 0 && (input.accounts?.length ?? 0) === 0;
}

export const CONNECTION_PRESETS = [
  { value: "minimal", label: "Minimal", description: "Everyday details, assigned skills and preferences. No memory, tasks or life-admin access." },
  { value: "standard", label: "Standard", description: "Adds memory, tasks and life-admin records. Services stay off until you select them." },
  { value: "custom", label: "Custom", description: "Choose permissions individually. Keeps your current choices so you can adjust them below." },
] as const;

// The starting choices for a template and the accounts that start ticked (those on for new
// agents). The template decides whether ticked accounts are granted at all: Minimal grants none.
export function connectionChoices(template: PermissionTemplate, tickedAccountIds: readonly string[] = []): ConnectionChoices {
  const set = permissionTemplate(template, tickedAccountIds);
  return {
    identity: set.lowTierProfile, memoryRead: set.sharedMemoryRead, memoryWrite: set.ownMemorySave,
    tasks: set.tasks, records: set.lifeAdmin, highTier: set.highTier, card: set.card,
    learningSharing: set.learningSharing, accounts: set.services.map(s => s.service),
    cardBudget: { amount: "200", period: "month" },
  };
}

/** Explicit booleans ensure a template can never restore an unchecked choice. */
export function connectionChoiceInput(state: ConnectionChoices, currency = "AUD") {
  const { accounts, cardBudget, ...toggles } = state;
  return {
    ...toggles, accounts: [...accounts],
    cardBudget: state.card ? { amount: Number(cardBudget.amount.trim() || Number.NaN), period: cardBudget.period, currency } : null,
  };
}

export const CONNECTION_CAPABILITIES: Record<ChoiceKey, { label: string; description: string; example: string }> = {
  identity: { label: "Read your everyday details", description: "Read everyday details in your vault without asking each time. Anything protected is asked for separately.", example: "For example, use your name or everyday contact details when helping you. You can restrict individual fields in this agent’s settings later." },
  memoryRead: { label: "Read shared memory", description: "Find memories available to this agent, including shared notes. Each memory’s audience still applies.", example: "For example, look up a travel preference you saved in Warthog. This does not grant access to another agent’s private memories." },
  memoryWrite: { label: "Save its own memories", description: "Save notes in Warthog for future use. New notes stay private to this agent unless sharing below is enabled.", example: "For example, remember a decision from a task. Reading and saving are separate permissions; you can allow either, both or neither." },
  tasks: { label: "Manage your tasks", description: "Read, create, update and complete tasks in your Warthog account.", example: "For example, create a follow-up task or mark a shared task complete. This includes making changes, not just viewing a to-do list." },
  records: { label: "Manage life-admin records", description: "Read, save and update your Warthog records, such as receipts, subscriptions and reminders.", example: "For example, save a receipt or update a subscription reminder. This does not itself grant access to a connected email or banking service." },
  highTier: { label: "Request protected details", description: "Ask for sensitive details from your vault. You must approve each release before the agent receives them.", example: "For example, request a passport detail for a booking. Switching this on permits a request; it does not reveal the detail now." },
  card: { label: "Request card details", description: "Ask to use a card within a budget. Every card release still needs your approval.", example: "For example, request card details for a purchase at an amount you approve. Warthog limits approved releases; it does not process the purchase or control charges made outside Warthog." },
  learningSharing: { label: "Share what it learns", description: "Make new memories it saves available to your other permitted agents, subject to each memory’s audience.", example: "For example, share a planning note with another connected agent. Existing memories do not change. No new memories can be saved while saving is off." },
};
