// Starting the admin handoff from the app host (docs/design/admin-portal.md §2): the
// Settings page's server action calls this with the raw `__Host-wh_session` cookie value.
// Identity comes from that cookie alone (never a client value); the person must be a live
// admin with a step-up fresher than five minutes; only then is a single-use handoff minted
// and the admin host's exchange URL returned. The destination is fixed (the derived admin
// origin plus `/session`), so there is nothing to redirect open. Every refusal is a plain
// reason the control turns into words; the audit metric carries only the outcome.

import { verifySession } from "../auth/session";
import { requireStepUp } from "../auth/step-up";
import { getUserById } from "../db/users";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import { ADMIN_HANDOFF, ADMIN_HANDOFF_OUTCOMES } from "../metrics/names";
import { tryRecord, type MetricSeam } from "../metrics/seam";
import { mintHandoff } from "./session";

export type HandoffResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: "signed_out" | "not_admin" | "step_up_required" };

export interface HandoffDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly adminOrigin: string;
  readonly recordMetric?: MetricSeam;
}

export const HANDOFF_PATH = "/session";

export async function startAdminHandoff(sessionToken: string | null, deps: HandoffDeps): Promise<HandoffResult> {
  const { db, clock, random, adminOrigin, recordMetric } = deps;
  if (sessionToken == null) return { ok: false, reason: "signed_out" };
  const session = await verifySession(db, sessionToken, { clock });
  if (!session) return { ok: false, reason: "signed_out" };

  const user = await getUserById(db, session.userId);
  if (!user || user.role !== "admin" || user.wrappedDek === "") {
    await tryRecord(recordMetric, { name: ADMIN_HANDOFF, value: 1, dimensions: { outcome: ADMIN_HANDOFF_OUTCOMES.notAdmin } });
    return { ok: false, reason: "not_admin" };
  }
  if (!requireStepUp(session, { clock })) {
    await tryRecord(recordMetric, { name: ADMIN_HANDOFF, value: 1, dimensions: { outcome: ADMIN_HANDOFF_OUTCOMES.stepUpRequired } });
    return { ok: false, reason: "step_up_required" };
  }

  const { token } = await mintHandoff(db, { sessionId: session.id, userId: user.id }, { clock, random });
  await tryRecord(recordMetric, { name: ADMIN_HANDOFF, value: 1, dimensions: { outcome: ADMIN_HANDOFF_OUTCOMES.minted } });
  return { ok: true, url: `${adminOrigin}${HANDOFF_PATH}?handoff=${token}` };
}
