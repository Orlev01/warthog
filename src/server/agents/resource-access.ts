import { withTransaction, type Db } from "../db/index";
import { listMemoriesForUser } from "../db/memories";
import { listHighTierFields } from "../db/high-tier-fields";
import { listIdentityFields } from "../db/identity-fields";
import type { ConnectionPermissions } from "../db/agent-permissions";

export function vaultFieldAllowed(
  grants: Pick<ConnectionPermissions, "identityFields">,
  id: string,
): boolean {
  return grants.identityFields == null || grants.identityFields.includes(id);
}
export async function highTierRequestAllowed(
  db: Db,
  userId: string,
  grants: ConnectionPermissions,
  field?: string,
): Promise<boolean> {
  if (grants.identityFields == null) return true;
  return (await listHighTierFields(db, userId)).some(
    (f) =>
      vaultFieldAllowed(grants, f.id) &&
      (field === f.id || field === f.type || field === f.label),
  );
}
export async function vaultChoices(
  db: Db,
  userId: string,
  dek: Uint8Array,
  grants: ConnectionPermissions,
) {
  const low = await listIdentityFields(db, userId, dek),
    high = await listHighTierFields(db, userId);
  return [
    ...low.map((f) => ({
      id: f.id,
      name: `${f.kind.replace(/_/g, " ")} · ${f.value.slice(0, 80)}`,
      tier: "low" as const,
    })),
    ...high.map((f) => ({ id: f.id, name: f.label, tier: "high" as const })),
  ].map((f) => ({ ...f, granted: vaultFieldAllowed(grants, f.id) }));
}
export async function ownsVaultFields(
  db: Db,
  userId: string,
  ids: readonly string[],
): Promise<boolean> {
  const rows = await db.query(
    "SELECT id FROM identity_fields WHERE user_id = $1 AND id = ANY($2::uuid[]) UNION ALL SELECT id FROM high_tier_fields WHERE user_id = $1 AND id = ANY($2::uuid[])",
    [userId, ids],
  );
  const owned = new Set(rows.rows.map((r) => String(r.id)));
  return ids.every((id) => owned.has(id));
}
export async function agentMemoryChoices(
  db: Db,
  userId: string,
  agentId: string,
  dek: Uint8Array,
) {
  const memories = await listMemoriesForUser(db, userId, dek);
  const { rows } = await db.query(
    "SELECT memory_id, allowed FROM agent_memory_access WHERE user_id = $1 AND agent_id = $2",
    [userId, agentId],
  );
  const overrides = new Map(
    rows.map((r) => [String(r.memory_id), Boolean(r.allowed)]),
  );
  return memories.map((m) => ({
    id: m.id,
    name: m.content,
    granted:
      overrides.get(m.id) ??
      (m.scope === "shared" || m.sourceAgentId === agentId),
  }));
}
export async function setAgentMemoryAccess(
  db: Db,
  userId: string,
  agentId: string,
  choices: readonly { id: string; granted: boolean }[],
): Promise<boolean> {
  if (!db.inTransaction)
    return withTransaction(db, (tx) =>
      setAgentMemoryAccess(tx, userId, agentId, choices),
    );
  if (
    !(
      await db.query("SELECT id FROM agents WHERE user_id = $1 AND id = $2", [
        userId,
        agentId,
      ])
    ).rows.length
  )
    return false;
  const rows = await db.query(
    "SELECT id FROM memories WHERE user_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE",
    [userId, choices.map((c) => c.id)],
  );
  const ids = new Set(rows.rows.map((r) => String(r.id)));
  if (choices.some((c) => !ids.has(c.id))) return false;
  for (const choice of choices)
    await db.query(
      "INSERT INTO agent_memory_access(user_id,agent_id,memory_id,allowed) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,agent_id,memory_id) DO UPDATE SET allowed = EXCLUDED.allowed",
      [userId, agentId, choice.id, choice.granted],
    );
  return true;
}

export async function mayCollectReleasedField(
  db: Db,
  userId: string,
  approvalId: string,
  grants: ConnectionPermissions,
): Promise<boolean> {
  if (grants.identityFields == null) return true;
  const row = (
    await db.query(
      "SELECT released_field_id FROM approvals WHERE user_id = $1 AND id = $2",
      [userId, approvalId],
    )
  ).rows[0];
  if (
    !row?.released_field_id ||
    !vaultFieldAllowed(grants, String(row.released_field_id))
  )
    return false;
  return (await listHighTierFields(db, userId)).some(
    (f) => f.id === row.released_field_id,
  );
}
