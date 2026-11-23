import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { selectBlobStore } from "@/server/storage/blob";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createLifeAdminActions, type ActionResult, type LifeAdminActions } from "./actions";
import { FORBIDDEN_NOTICES, type Notice } from "./notices";
import { noticeField } from "./form-inputs";

// The server wiring Life admin's pages share (the list page and an item's own page): the
// verified session, the actions seam built with the real seams, and `run` — one mutation under
// the verified session, then a redirect back with a notice naming the outcome. Config is read
// inside the handler (`loadConfig()`), never at module load; the database is the process-wide
// `getServerDb()` handle. No identity ever comes from the client.

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
export async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the life-admin actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) unwraps the session person's own DEK; the blob
// store (in-memory outside production, Azure in production) holds receipt ciphertext;
// the system clock supplies `now`.
export function buildActions(db: Db): LifeAdminActions {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const blob = selectBlobStore({
    nodeEnv: config.nodeEnv,
    account: config.blob.account,
    container: config.blob.container,
  });
  return createLifeAdminActions({ db, keyWrapper, clock: systemClock, blob });
}

// What a finished action reports back in the address: its notice, the field a refusal names
// (`&field=`, a label, never a value), and the record to land on (`#record-<id>`).
export type Outcome = { readonly notice: Notice; readonly field?: string; readonly recordId?: string };

// A refusal's reason as a notice (anything else is a plain problem).
const REASON_NOTICES: Readonly<Record<string, Notice>> = {
  empty: "record_empty",
  full: "journal_full",
  not_added: "journal_invalid",
  unknown_agent: "steward_unknown",
};

// Run one mutation against the seam under the verified session and redirect back with a
// notice naming the outcome. `success` is the notice for a success, or works one out from
// the result. A refusal ({ ok: false }) becomes a plain problem: an identifier Warthog never
// keeps names its rule and field. A 4xx `HttpError` from the validation boundary becomes
// `invalidNotice`; a genuine fault rethrows. A refusal returns to `failurePath` (the form it
// came from) when one is given. `anchor: false` leaves the `#record-<id>` hash off (an item's
// own page).
export async function run(
  success: Notice | ((result: Extract<ActionResult, { ok: true }>) => Outcome),
  mutate: (actions: LifeAdminActions, session: Session) => Promise<ActionResult>,
  returnPath = "/life-admin",
  invalidNotice: Notice = "invalid_input",
  failurePath = returnPath,
  options: { readonly anchor?: boolean; readonly revalidate?: readonly string[] } = {},
): Promise<never> {
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: Outcome = { notice: typeof success === "string" ? success : "problem" };
  let path = returnPath;
  try {
    const result = await mutate(buildActions(db), session);
    if (result.ok) {
      outcome = typeof success === "string" ? { notice: success } : success(result);
    } else {
      path = failurePath;
      outcome = result.refusal
        ? { notice: FORBIDDEN_NOTICES[result.refusal.rule], field: result.refusal.field }
        : { notice: REASON_NOTICES[result.reason] ?? "problem" };
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    path = failurePath;
    outcome = { notice: error.status === 413 ? "file_too_large" : error.status === 400 || error.status === 422 ? invalidNotice : "problem" };
  }
  revalidatePath("/life-admin");
  for (const extra of options.revalidate ?? []) revalidatePath(extra);
  const field = outcome.field && noticeField(outcome.field) ? `&field=${encodeURIComponent(outcome.field)}` : "";
  const hash = outcome.recordId && options.anchor !== false ? `#record-${encodeURIComponent(outcome.recordId)}` : "";
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${outcome.notice}${field}${hash}`);
}
