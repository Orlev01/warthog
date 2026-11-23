// Which of the person's accounts an agent's call uses (docs/adr/several-accounts-per-agent.md).
//
// An agent is given ACCOUNTS, not services: each granted account of a service carries its
// own read, change and tool settings, falling back to the agent's own where it has none.
// Every connector call is bound to exactly one granted account before the policy runs, so
// that account's settings are the ones checked, held, executed and undone. The agent may
// name the account (its address or label, or its handle); Warthog never falls back to a
// different account, and a refusal never reveals an account the agent wasn't given.
//
// Pure: no I/O. The same predicate decides what tools/list offers, which account a call
// can use and what get_context says, so the three always agree.

import { createHash } from "node:crypto";

export type ChangeSetting = "off" | "allow" | "ask_first";

// One account an agent may use, with its own settings (unset = the same as the agent's).
export interface AccountGrant {
  readonly accountId: string;
  readonly connectorId: string;
  readonly readTools?: boolean;
  readonly changeTools?: ChangeSetting;
  // Exact tool names this account may use; null or unset keeps every current and future tool.
  readonly allowedTools?: readonly string[] | null;
}

// A connected account as binding sees it.
export interface ServiceAccount {
  readonly id: string;
  readonly connectorId: string;
  readonly label: string;
  readonly connected: boolean;
}

export interface AgentDefaults {
  readonly readTools: boolean;
  readonly changeTools: ChangeSetting;
}

export interface AccountPolicy {
  readonly readTools: boolean;
  readonly changeTools: ChangeSetting;
  readonly allowedTools: readonly string[] | null;
}

// A tool as the predicate needs it. `request` marks the general request tool, which is a read
// or a change by HTTP method and so is offered when either is allowed.
export interface ToolUse {
  readonly name: string;
  readonly makesChange: boolean;
  readonly request?: boolean;
}

export interface GrantedAccount {
  readonly grant: AccountGrant;
  readonly account: ServiceAccount;
}

export type AccountBinding =
  | { readonly kind: "bound"; readonly account: ServiceAccount }
  | { readonly kind: "refused"; readonly reason: string };

export interface BindRequest {
  // The service's name as people know it ("Gmail").
  readonly serviceName: string;
  // This agent's granted accounts of the service, from `grantedAccounts`.
  readonly granted: readonly GrantedAccount[];
  readonly defaults: AgentDefaults;
  readonly tool: ToolUse;
  // The account the agent asked for. Untrusted: it can only pick among `granted`.
  readonly named?: string;
  // The account Warthog bound earlier (an approved request, an Undo). Server-owned.
  readonly presetId?: string;
}

const CHANGED = "The service account changed or is unavailable. Submit a new request.";
const HANDLE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function accountPolicy(grant: AccountGrant | undefined, defaults: AgentDefaults): AccountPolicy {
  return {
    readTools: grant?.readTools ?? defaults.readTools,
    changeTools: grant?.changeTools ?? defaults.changeTools,
    allowedTools: grant?.allowedTools ?? null,
  };
}

export function toolPermitted(policy: AccountPolicy, tool: ToolUse): boolean {
  if (policy.allowedTools && !policy.allowedTools.includes(tool.name)) return false;
  if (tool.request) return policy.readTools || policy.changeTools !== "off";
  return tool.makesChange ? policy.changeTools !== "off" : policy.readTools;
}

// A short name for an account that agents can pass back and that ids can carry. It is a
// digest of the connection id, so it says nothing about the account, never changes (a
// reconnect keeps the id) and can't be turned back into the id.
export function accountHandle(accountId: string): string {
  const digest = createHash("sha256").update(`warthog-account:${accountId}`).digest();
  let handle = "";
  for (let i = 0; i < 6; i += 1) handle += HANDLE_ALPHABET[digest[i]! % HANDLE_ALPHABET.length];
  return handle;
}

// The agent's granted accounts of one service that the person still has, by name.
export function grantedAccounts(
  grants: readonly AccountGrant[],
  accounts: readonly ServiceAccount[],
  connectorId: string,
): GrantedAccount[] {
  const byId = new Map(accounts.filter((a) => a.connectorId === connectorId).map((a) => [a.id, a]));
  const found: GrantedAccount[] = [];
  for (const grant of grants) {
    const account = grant.connectorId === connectorId ? byId.get(grant.accountId) : undefined;
    if (account && !found.some((g) => g.account.id === account.id)) found.push({ grant, account });
  }
  return found.sort((a, b) => a.account.label.localeCompare(b.account.label, "en", { sensitivity: "base" }) || a.account.id.localeCompare(b.account.id));
}

const names = (granted: readonly GrantedAccount[]) => granted.map((g) => g.account.label).join(", ");

// Find the granted account an agent named, by handle or by label (any case).
function resolveNamed(named: string, granted: readonly GrantedAccount[], serviceName: string): AccountBinding {
  const wanted = named.trim().toLowerCase();
  const byHandle = granted.find((g) => accountHandle(g.account.id) === wanted);
  if (byHandle) return { kind: "bound", account: byHandle.account };
  const byLabel = granted.filter((g) => g.account.label.trim().toLowerCase() === wanted);
  if (byLabel.length === 1) return { kind: "bound", account: byLabel[0]!.account };
  if (byLabel.length > 1) {
    const handles = byLabel.map((g) => accountHandle(g.account.id)).sort().join(", ");
    return { kind: "refused", reason: `Two of this agent's ${serviceName} accounts are called “${byLabel[0]!.account.label}”. Name one by its handle: ${handles}.` };
  }
  // The same words whether or not the account exists, so naming accounts can't probe for them.
  return {
    kind: "refused",
    reason: granted.length > 0
      ? `This agent can't use that ${serviceName} account. Accounts it can use: ${names(granted)}.`
      : `This agent has no ${serviceName} account to use. The person can turn one on in Warthog → Agents.`,
  };
}

// Bind a call to one granted account, or refuse it. Never picks an account the agent wasn't
// given, and never swaps an unavailable account for another.
export function bindAccount(request: BindRequest): AccountBinding {
  const { granted, serviceName } = request;
  const named = request.named?.trim() ? request.named : undefined;
  let binding: AccountBinding;
  if (request.presetId !== undefined) {
    const preset = granted.find((g) => g.account.id === request.presetId);
    if (!preset) return { kind: "refused", reason: CHANGED };
    if (named) {
      const asked = resolveNamed(named, granted, serviceName);
      if (asked.kind !== "bound" || asked.account.id !== preset.account.id) return { kind: "refused", reason: CHANGED };
    }
    binding = { kind: "bound", account: preset.account };
  } else if (named) {
    binding = resolveNamed(named, granted, serviceName);
  } else if (granted.length === 0) {
    return { kind: "refused", reason: `This agent has no ${serviceName} account to use. The person can turn one on in Warthog → Agents.` };
  } else if (granted.length === 1) {
    binding = { kind: "bound", account: granted[0]!.account };
  } else {
    // Ambiguity is decided by what the agent was given and allowed, never by which accounts
    // happen to be working.
    const allowed = granted.filter((g) => toolPermitted(accountPolicy(g.grant, request.defaults), request.tool));
    if (allowed.length === 0) return { kind: "refused", reason: `This agent isn't allowed to do that with any of its ${serviceName} accounts.` };
    if (allowed.length > 1) {
      return { kind: "refused", reason: `This agent can use ${allowed.length} ${serviceName} accounts for this: ${names(allowed)}. Say which one in account.` };
    }
    binding = { kind: "bound", account: allowed[0]!.account };
  }
  if (binding.kind === "bound" && !binding.account.connected) {
    return { kind: "refused", reason: `${binding.account.label} needs reconnecting. The person can reconnect it in Warthog → Connectors.` };
  }
  return binding;
}
