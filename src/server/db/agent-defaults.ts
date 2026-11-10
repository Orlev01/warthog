import { z } from "zod";
import type { Db } from "./index";
import { parseParams } from "../http/validate";

export const agentDefaultsSchema = z.object({
  template: z.enum(["minimal", "standard"]),
  rateLimit: z.number().int().min(1).max(10000),
});
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;

// Defaults seed new connections only. Existing grants remain explicit snapshots.
export async function getAgentDefaults(
  db: Db,
  userId: string,
): Promise<AgentDefaults> {
  const { rows } = await db.query(
    "SELECT template, rate_limit FROM agent_defaults WHERE user_id = $1",
    [userId],
  );
  return rows[0]
    ? agentDefaultsSchema.parse({
        template: rows[0].template,
        rateLimit: Number(rows[0].rate_limit),
      })
    : { template: "standard", rateLimit: 120 };
}

export async function saveAgentDefaults(
  db: Db,
  userId: string,
  input: AgentDefaults,
): Promise<void> {
  const valid = parseParams(agentDefaultsSchema, input);
  await db.query(
    `INSERT INTO agent_defaults (user_id, template, rate_limit) VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET template = EXCLUDED.template, rate_limit = EXCLUDED.rate_limit`,
    [userId, valid.template, valid.rateLimit],
  );
}
