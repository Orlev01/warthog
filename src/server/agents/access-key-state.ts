// Whether an agent connects with a Warthog access key (`wh_ak_…`), and whether that key
// still works — what the agent's Settings section needs to decide on its "Access key"
// panel (brief "Connect an agent": "lets them revoke or replace the key later from that
// agent's page"), and what the access-key actions check before minting a key.
//
// Two sources, both member-scoped:
//   • a stored access key bound to the agent's connection (only its hash is kept), which
//     makes the key "active";
//   • otherwise the activity record of how the agent connected: the `agent_connected`
//     entry the access-key flow writes carries `credentialKind: "access_key"`, while the
//     OAuth consent flow writes `"oauth"`. An access-key agent whose key was revoked has no
//     stored key but still that record, so it reads "revoked". The record's payload is
//     encrypted under the person's data key, so it is read only when there is no key.
// An agent with neither (an OAuth agent, or one with no record of how it connected) has no
// access-key state: it gets no panel, and no key is ever minted for it.
//
// The caller passes an agent it resolved for this person (getAgentById with the session's
// user id); one owned by anyone else has no state here. Nothing secret is read or returned:
// the key hash is only tested for presence.

import { listActivity } from "../activity/list";
import type { Agent } from "../db/agents";
import type { Db } from "../db/index";

export type AccessKeyState = "active" | "revoked";

// Whether a working access key is bound to this connection (the id is bound, never
// concatenated). Callers take it from an agent resolved for the session's person.
export async function hasAccessKey(db: Db, connectionId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM oauth_access_keys WHERE connection_id = $1::uuid LIMIT 1",
    [connectionId],
  );
  return result.rows.length > 0;
}

// Whether this person's agent was connected with an access key, by the activity entry its
// connection wrote (member-scoped by `userId` and the agent's id).
export async function connectedWithAccessKey(
  db: Db,
  userId: string,
  agentId: string,
  dek: Uint8Array,
): Promise<boolean> {
  const [entry] = await listActivity(db, userId, { agentId, kind: "agent_connected" }, dek, { limit: 1 });
  const payload = entry?.payload as { changes?: { credentialKind?: unknown } } | undefined;
  return payload?.changes?.credentialKind === "access_key";
}

// "active" (a working key), "revoked" (an access-key agent with no working key), or null
// (not an access-key agent, or not this person's). The data key is fetched only if needed.
export async function accessKeyState(
  db: Db,
  userId: string,
  agent: Pick<Agent, "id" | "userId" | "connectionId">,
  dek: () => Promise<Uint8Array>,
): Promise<AccessKeyState | null> {
  if (agent.userId !== userId) return null;
  if (await hasAccessKey(db, agent.connectionId)) return "active";
  return (await connectedWithAccessKey(db, userId, agent.id, await dek())) ? "revoked" : null;
}
