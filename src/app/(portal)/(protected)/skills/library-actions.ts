"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/server/auth/session";
import { getServerDb } from "@/server/db/server";
import { loadConfig } from "@/server/config";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import { PackageError } from "@/domain/skills/package";
import { createLibraryActions, previewUpload } from "@/server/skills/library";

async function run<T>(operation: (actions: ReturnType<typeof createLibraryActions>, session: NonNullable<Awaited<ReturnType<typeof verifySession>>>) => Promise<T>) {
  try {
    const token = (await cookies()).get("__Host-wh_session")?.value;
    const db = await getServerDb();
    const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
    if (!session) return { ok: false as const, error: "Sign in again to manage your library." };
    const config = loadConfig();
    const actions = createLibraryActions({ db, keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }) });
    const value = await operation(actions, session);
    return { ok: true as const, value };
  } catch (e) {
    return { ok: false as const, error: e instanceof PackageError ? e.message : e instanceof HttpError ? "Check the files and fields, then try again." : "Could not complete that change. Your edits are still here; please try again." };
  }
}

export async function previewPackageAction(form: FormData) { return run(() => previewUpload(form)); }
export async function loadPackageAction(id: string) { return run((actions, session) => actions.load(session, { id })); }
export async function savePackageAction(input: unknown) {
  return run(async (actions, session) => { const value = await actions.save(session, input); revalidatePath("/skills"); return value; });
}
export async function deletePackageAction(input: unknown) {
  return run(async (actions, session) => { await actions.remove(session, input); revalidatePath("/skills"); return null; });
}
export async function downloadPackageAction(id: string) { return run((actions, session) => actions.download(session, { id })); }
export async function saveSkillAccessAction(input: unknown) {
  return run(async (actions, session) => { await actions.access(session, input); revalidatePath("/skills"); return null; });
}
