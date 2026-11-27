"use server";

// Changes to one of Warthog's skills from its editor on the Skills page
// (src/components/skills/warthog-skills.tsx), called like the package editor's actions
// (./library-actions): the session is re-derived from the cookie, the seam validates the input
// (an unknown key, a blank or too-long field, another person's agent are all refused there),
// and the editor gets back a plain result to show, never a thrown error.

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/server/auth/session";
import { getServerDb } from "@/server/db/server";
import { loadConfig } from "@/server/config";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import { createSkillsActions, type WarthogSkillChangeInput } from "./actions";

export type WarthogSkillChangeResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function changeWarthogSkillAction(input: unknown): Promise<WarthogSkillChangeResult> {
  try {
    const token = (await cookies()).get("__Host-wh_session")?.value;
    const db = await getServerDb();
    const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
    if (!session) return { ok: false, error: "Sign in again to change your skills." };
    const config = loadConfig();
    const actions = createSkillsActions({ db, keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }) });
    // The seam parses the input itself; nothing here trusts its shape.
    const result = await actions.changeWarthogSkill(session, input as WarthogSkillChangeInput);
    revalidatePath("/skills");
    if (result.ok) return { ok: true };
    return {
      ok: false,
      error: (result as { reason?: string }).reason === "unknown_agent"
        ? "One of the agents you chose is no longer connected. Choose again."
        : "We couldn't save that change. Please try again.",
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof HttpError ? "Check the fields, then try again." : "We couldn't save that change. Your edits are still here; please try again.",
    };
  }
}
