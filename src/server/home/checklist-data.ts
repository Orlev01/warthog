// E18-S04 — Set-up checklist status read (brief "HOME — a set-up checklist";
// design §5 — every member-scoped read takes the user id from the session, never
// a client value).
//
// The home loader needs ONE owner-scoped read that turns the person's REAL set-up
// state into the checklist. It gathers the five first-run signals — an identity
// detail beyond the sign-up name, a saved card, a connected service, a connected agent, a
// registered push device — by REUSING the already-built stores (`identity-fields`,
// `cards`, `connections`, `agents`, `push-subscriptions`) rather than re-querying
// ad hoc, and turns them into the checklist through the ONE pure source of the five
// items, `computeSetupChecklist` (E18-S03).
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
import { listHighTierFields } from "../db/high-tier-fields";
import { listIdentityFields } from "../db/identity-fields";
import type { Db } from "../db/index";
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

  const identityFields = await listIdentityFields(db, userId, dek);
  const protectedDetails = await listHighTierFields(db, userId);
  const cards = await listCards(db, userId);
  const connections = await listConnectionsForUser(db, userId);
  const agents = await listAgentsForUser(db, userId);
  const subscriptions = await listSubscriptions(db, userId, dek, clock);

  return computeSetupChecklist({
    // "Add your details" is done once the person has added a detail of their own: sign-up
    // saves their name for them, so the name alone never counts (UI/UX pass, newcomer-01).
    // A protected detail (passport, licence…) counts too.
    identityAdded: identityFields.some((field) => field.kind !== "name") || protectedDetails.length > 0,
    cardAdded: cards.length > 0,
    serviceConnected: connections.length > 0,
    agentConnected: agents.length > 0,
    notificationsEnabled: subscriptions.length > 0,
  });
}
