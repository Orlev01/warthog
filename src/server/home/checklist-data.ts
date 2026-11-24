// E18-S04 — Set-up checklist status read (brief "HOME — a set-up checklist";
// design §5 — every member-scoped read takes the user id from the session, never
// a client value).
//
// The home loader needs ONE owner-scoped read that turns the person's REAL set-up
// state into the checklist. It gathers the five first-run signals — a built profile (something
// an agent found that the person checked, or enough in Life admin), a saved card, a service an
// agent can read, a connected agent, a registered push device — by REUSING the already-built
// stores (`life-admin-records`, `identity-suggestions`, `cards`, `connections`,
// `agent-permissions`, `agents`, `push-subscriptions`) rather than re-querying ad hoc, and turns
// them into the checklist through the ONE pure source of the five items, `computeSetupChecklist`.
//
// It adds NO SQL and NO crypto of its own. Like the vault page-data read it
// resolves the person's DEK through the injected `KeyWrapper` seam (read the
// wrapped DEK from `users.wrapped_dek`, unwrap it) so the identity + push reads can
// decrypt; it reads no `process.env` and holds no key (INV-103). Every read is
// member-scoped by the session's `userId`, never a client value, and each
// underlying store binds its ids as parameters, so an id shaped like SQL travels as
// data and cannot alter a query (INV-102).

import { computeSetupChecklist, type SetupChecklistItem } from "../../domain/home/checklist";
import { listAgentsForUser } from "../db/agents";
import { listCards } from "../db/cards";
import { listConnectionsForUser } from "../db/connections";
import { getConnectionPermissions } from "../db/agent-permissions";
import { countIdentitySuggestions } from "../db/identity-suggestions";
import { countRecordReview } from "../db/life-admin-records";
import type { Db } from "../db/index";
import { accountPolicy } from "../../domain/permissions/account-access";
import { SPARSE_RECORDS } from "../../domain/life-admin/summary";
import { listSubscriptions } from "../db/push-subscriptions";
import { getUserById } from "../db/users";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";

// The injected seams — no process.env. `db` is the parameterizing database seam;
// `keyWrapper` unwraps the person's DEK (from users.wrapped_dek) so the identity +
// push reads can decrypt; `clock` is "now" for the push store's active/expired
// filter.
export interface SetupChecklistDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK (bound by
// userId through the users store) and unwrap it through the KeyWrapper seam. Throws
// when the person has no row (never fails silently) — the vault page-data idiom.
async function dataKeyFor(db: Db, keyWrapper: KeyWrapper, userId: string): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("loadSetupChecklist: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// Gather the five set-up signals for `userId` (the SESSION's id, NEVER a client
// value) from the five stores and return `computeSetupChecklist(signals)` — the five
// first-run items, each `done` iff its own signal is present. Every underlying read
// is member-scoped by `userId`.
export async function loadSetupChecklist(
  deps: SetupChecklistDeps,
  userId: string,
): Promise<SetupChecklistItem[]> {
  const { db, keyWrapper, clock } = deps;

  // Resolve the person's data key first (the identity + push reads need it to
  // decrypt; the member-scoped lookup also binds `userId` as a parameter).
  const dek = await dataKeyFor(db, keyWrapper, userId);

  const cards = await listCards(db, userId);
  const connections = await listConnectionsForUser(db, userId);
  const agents = await listAgentsForUser(db, userId);
  const subscriptions = await listSubscriptions(db, userId, dek, clock);
  const records = await countRecordReview(db, userId);
  const aboutYouWaiting = await countIdentitySuggestions(db, userId);

  return computeSetupChecklist({
    // "Build your profile" (docs/adr/profile-build.md) is done once the person has checked
    // something an agent found, or keeps enough in Life admin themselves (for someone who'd
    // rather no agent read anything). Until then, what waits for them shows beside it.
    profileBuilt: records.agentConfirmed > 0 || records.confirmed >= SPARSE_RECORDS,
    profileWaiting: records.waiting + aboutYouWaiting,
    cardAdded: cards.length > 0,
    // A service counts once an agent can read it: connected, and granted with reads to at least
    // one agent (audit W-11). Connecting one no agent can use isn't set up yet.
    serviceConnected: await anyServiceReadable(db, userId, connections, agents),
    agentConnected: agents.length > 0,
    notificationsEnabled: subscriptions.length > 0,
  });
}

// Whether any of the person's connected accounts is readable by at least one of their agents.
async function anyServiceReadable(
  db: Db,
  userId: string,
  connections: readonly { readonly id: string; readonly status: string }[],
  agents: readonly { readonly connectionId: string }[],
): Promise<boolean> {
  const connected = new Set(connections.filter((account) => account.status === "connected").map((account) => account.id));
  if (connected.size === 0) return false;
  for (const agent of agents) {
    const permissions = await getConnectionPermissions(db, userId, agent.connectionId);
    if (permissions?.accounts.some((grant) => connected.has(grant.accountId) && accountPolicy(grant, permissions).readTools)) return true;
  }
  return false;
}
