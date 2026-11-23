// Which of a person's accounts an agent's call uses (docs/adr/several-accounts-per-agent.md).
// One agent can be given several accounts of a service, each with its own settings; a call
// is bound to exactly one of them before any policy runs, and never falls back to another.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accountHandle,
  accountPolicy,
  bindAccount,
  grantedAccounts,
  toolPermitted,
  type AccountGrant,
  type ServiceAccount,
} from "./account-access";

const HOME: ServiceAccount = { id: "11111111-1111-4111-8111-111111111111", connectorId: "google-gmail", label: "home@gmail.com", connected: true };
const WORK: ServiceAccount = { id: "22222222-2222-4222-8222-222222222222", connectorId: "google-gmail", label: "Work@Gmail.com", connected: true };
const SPARE: ServiceAccount = { id: "33333333-3333-4333-8333-333333333333", connectorId: "google-gmail", label: "spare@gmail.com", connected: true };
const NOTION: ServiceAccount = { id: "44444444-4444-4444-8444-444444444444", connectorId: "notion", label: "Notion", connected: true };
const DEFAULTS = { readTools: true, changeTools: "ask_first" as const };
const SEARCH = { name: "google-gmail__search", makesChange: false };
const SEND = { name: "google-gmail__send", makesChange: true };

const grant = (account: ServiceAccount, settings: Partial<AccountGrant> = {}): AccountGrant => ({ accountId: account.id, connectorId: account.connectorId, ...settings });
const granted = (...pairs: Array<[ServiceAccount, Partial<AccountGrant>?]>) => pairs.map(([account, settings]) => ({ account, grant: grant(account, settings) }));
const bind = (input: Partial<Parameters<typeof bindAccount>[0]> & Pick<Parameters<typeof bindAccount>[0], "granted">) =>
  bindAccount({ serviceName: "Gmail", defaults: DEFAULTS, tool: SEARCH, ...input });

test("an account's own settings win; an unset one is the same as the agent's", () => {
  assert.deepEqual(accountPolicy(grant(HOME), DEFAULTS), { readTools: true, changeTools: "ask_first", allowedTools: null });
  assert.deepEqual(accountPolicy(grant(HOME, { readTools: false, changeTools: "off", allowedTools: ["google-gmail__read"] }), DEFAULTS), { readTools: false, changeTools: "off", allowedTools: ["google-gmail__read"] });
  assert.deepEqual(accountPolicy(undefined, DEFAULTS), { readTools: true, changeTools: "ask_first", allowedTools: null });
});

test("a tool is permitted by its class and the account's chosen tools", () => {
  const all = accountPolicy(grant(HOME), DEFAULTS);
  assert.equal(toolPermitted(all, SEARCH), true);
  assert.equal(toolPermitted(all, SEND), true);
  assert.equal(toolPermitted(accountPolicy(grant(HOME, { changeTools: "off" }), DEFAULTS), SEND), false);
  assert.equal(toolPermitted(accountPolicy(grant(HOME, { readTools: false }), DEFAULTS), SEARCH), false);
  assert.equal(toolPermitted(accountPolicy(grant(HOME, { allowedTools: ["google-gmail__search"] }), DEFAULTS), SEND), false);
  assert.equal(toolPermitted(accountPolicy(grant(HOME, { allowedTools: [] }), DEFAULTS), SEARCH), false, "an empty choice grants none");
  // The general request tool is a read or a change by method, so it is offered when either is on.
  const request = { name: "amadeus__request", makesChange: true, request: true };
  assert.equal(toolPermitted(accountPolicy(grant(HOME, { readTools: false, changeTools: "off" }), DEFAULTS), request), false);
  assert.equal(toolPermitted(accountPolicy(grant(HOME, { changeTools: "off" }), DEFAULTS), request), true);
});

test("a handle is short, stable and different for each account", () => {
  assert.match(accountHandle(HOME.id), /^[a-z2-9]{6}$/);
  assert.equal(accountHandle(HOME.id), accountHandle(HOME.id));
  assert.notEqual(accountHandle(HOME.id), accountHandle(WORK.id));
});

test("only the agent's grants of that service, for accounts the person still has, count", () => {
  const grants = [grant(WORK), grant(NOTION), grant(HOME), { accountId: "55555555-5555-4555-8555-555555555555", connectorId: "google-gmail" }];
  const found = grantedAccounts(grants, [HOME, WORK, SPARE, NOTION], "google-gmail");
  assert.deepEqual(found.map((g) => g.account.id), [HOME.id, WORK.id], "sorted by name, the missing account and the ungranted SPARE left out");
});

test("one granted account is used without being named", () => {
  const result = bind({ granted: granted([HOME]) });
  assert.equal(result.kind, "bound");
  assert.equal(result.kind === "bound" && result.account.id, HOME.id);
});

test("a named account is matched by its address in any case, or by its handle", () => {
  for (const named of ["work@gmail.com", "WORK@GMAIL.COM", " Work@Gmail.com ", accountHandle(WORK.id)]) {
    const result = bind({ granted: granted([HOME], [WORK]), named });
    assert.equal(result.kind === "bound" && result.account.id, WORK.id, named);
  }
});

test("an account the agent wasn't given is refused the same way whether or not it exists", () => {
  const unknown = bind({ granted: granted([HOME], [WORK]), named: "nobody@gmail.com" });
  const ungranted = bind({ granted: granted([HOME], [WORK]), named: SPARE.label });
  const ungrantedHandle = bind({ granted: granted([HOME], [WORK]), named: accountHandle(SPARE.id) });
  assert.equal(unknown.kind, "refused");
  assert.equal(unknown.kind === "refused" && unknown.reason, "This agent can't use that Gmail account. Accounts it can use: home@gmail.com, Work@Gmail.com.");
  assert.deepEqual(ungranted, unknown);
  assert.deepEqual(ungrantedHandle, unknown);
});

test("with several accounts and none named, the one the tool is allowed on is used", () => {
  const result = bind({ granted: granted([HOME, { changeTools: "off" }], [WORK]), tool: SEND });
  assert.equal(result.kind === "bound" && result.account.id, WORK.id);
});

test("with several accounts allowed and none named, the agent is asked to say which", () => {
  const result = bind({ granted: granted([HOME], [WORK], [SPARE, { readTools: false }]) });
  assert.deepEqual(result, { kind: "refused", reason: "This agent can use 2 Gmail accounts for this: home@gmail.com, Work@Gmail.com. Say which one in account." });
});

test("with several accounts and none allowed, the call is refused without picking one", () => {
  const result = bind({ granted: granted([HOME, { changeTools: "off" }], [WORK, { changeTools: "off" }]), tool: SEND });
  assert.deepEqual(result, { kind: "refused", reason: "This agent isn't allowed to do that with any of its Gmail accounts." });
});

test("one granted account that doesn't allow the tool is still bound, so the policy gives the reason", () => {
  const result = bind({ granted: granted([HOME, { changeTools: "off" }]), tool: SEND });
  assert.equal(result.kind === "bound" && result.account.id, HOME.id);
});

test("no granted account of the service is refused", () => {
  assert.deepEqual(bind({ granted: [] }), { kind: "refused", reason: "This agent has no Gmail account to use. The person can turn one on in Warthog → Agents." });
});

test("an account that needs reconnecting is refused, never swapped for another", () => {
  const stale = { ...HOME, connected: false };
  assert.deepEqual(bind({ granted: granted([stale], [WORK]), named: HOME.label }), { kind: "refused", reason: "home@gmail.com needs reconnecting. The person can reconnect it in Warthog → Connectors." });
  // Ambiguity is decided by what the agent was given, not by which accounts are working.
  assert.equal(bind({ granted: granted([stale], [WORK]) }).kind, "refused");
  assert.match((bind({ granted: granted([stale], [WORK]) }) as { reason: string }).reason, /Say which one/);
});

test("an account Warthog bound earlier (an approved request, an Undo) must still be granted", () => {
  assert.equal(bind({ granted: granted([HOME], [WORK]), presetId: WORK.id }).kind, "bound");
  const gone = bind({ granted: granted([HOME]), presetId: WORK.id });
  assert.deepEqual(gone, { kind: "refused", reason: "The service account changed or is unavailable. Submit a new request." });
  // A named account that disagrees with the bound one never wins.
  assert.deepEqual(bind({ granted: granted([HOME], [WORK]), presetId: WORK.id, named: HOME.label }), gone);
});

test("two granted accounts with the same name must be named by handle", () => {
  const twin = { ...NOTION, id: "66666666-6666-4666-8666-666666666666" };
  const result = bind({ serviceName: "Notion", granted: granted([NOTION], [twin]), named: "notion", tool: { name: "notion__search", makesChange: true } });
  assert.equal(result.kind, "refused");
  assert.equal(result.kind === "refused" && result.reason, `Two of this agent's Notion accounts are called “Notion”. Name one by its handle: ${[NOTION, twin].map((a) => accountHandle(a.id)).sort().join(", ")}.`);
  assert.equal(bind({ serviceName: "Notion", granted: granted([NOTION], [twin]), named: accountHandle(twin.id), tool: { name: "notion__search", makesChange: true } }).kind, "bound");
});
