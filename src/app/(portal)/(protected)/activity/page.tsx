import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { ActivityView } from "@/components/activity/activity-view";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { getUserById } from "@/server/db/users";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { createDbRecorder } from "@/server/activity/writer";
import { createDisputeRepo } from "@/server/activity/disputes";
import { createUndoService } from "@/server/activity/undo";
import { systemClock } from "@/server/seams/clock";
import type { Db } from "@/server/db/index";
import { createActivityActions } from "./actions";
import { noticeLocation, activityNotice, type ActivityNotice } from "./notices";

// E08-S10 — Activity page (the thin protected-page loader + Dispute/Undo wiring).
//
// The loader triad: this async `page.tsx` reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the tested
// `createActivityActions` seam's `load`) into the <ActivityView> props — the person's
// OWN entries, newest-first, narrowed by the view's filters/search — and renders the
// view. The record-wide Check-integrity control posts `verify=1`, which `load` runs.
//
// E08-S09 shipped Dispute/Undo as forms that posted nowhere (dead controls). This task
// binds Dispute to an inline `use server` wrapper (`disputeEntryAction`) that re-derives
// the session, calls `disputeEntry`, and redirects back with a `?notice=` outcome the
// page renders in plain words (the sibling security screen's pattern). Reversal EXECUTION
// is not wired yet (`runReversal` throws), so the page supplies NO `undoAction`: a
// reversible entry's Undo renders DISABLED with a one-line reason rather than a live
// control over a throwing executor (constitution: no dead controls). When reversal
// execution lands, bind an `undoEntryAction` wrapper the same way and pass it here.
//
// Thin by design (the server-composition-roots addendum): per-request data (the cookie,
// the search params) is read BEFORE `getServerDb()` so touching it marks the page dynamic
// and `next build` never prerenders it or opens the database at build time; config is read
// inside the handler (`loadConfig()`), never at module load; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed.
// The `(protected)` layout already wraps every page in the app shell (PortalChrome).

const SESSION_COOKIE = "__Host-wh_session";

// The declared reversals (design §7): a created calendar event is undone by deleting it.
// ONE table backs both the loader's `canUndo` and the undo service's "is this reversible?"
// decision, so an Undo control shows only where undoEntry can act.
const REVERSALS: Record<string, string> = {
  google_calendar__create_event: "google_calendar__delete_event",
};
function reversalFor(tool?: string): string | undefined {
  return tool ? REVERSALS[tool] : undefined;
}

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the activity actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets `load` resolve the session person's DEK;
// `dekFor` is the loadAgentContext idiom (the person's wrapped DEK, unwrapped) the dispute
// repo and the undo recorder encrypt/decrypt the person's OWN content under.
function buildActions(db: Db, nodeEnv: string, devKek: Uint8Array | undefined) {
  const keyWrapper = selectKeyWrapper({ nodeEnv, localKek: devKek });
  const dekFor = async (userId: string): Promise<Uint8Array> => {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  };

  const disputes = createDisputeRepo({ db, clock: systemClock, dekFor });
  const undo = createUndoService({
    db,
    recorder: createDbRecorder({ db, clock: systemClock, dekFor }),
    reversalFor,
    // The reversal executor routes through the agent pipeline, wired by a later task;
    // until then it rejects loudly rather than silently doing nothing (the compose.ts
    // not-configured idiom). The page supplies no undoAction while it is unwired, so this
    // is never invoked from the screen; undoEntry's own tests drive the undo service.
    runReversal: async () => {
      throw new Error("undo execution is not configured");
    },
  });

  return createActivityActions({ db, disputes, undo, keyWrapper, reversalFor });
}

// Dispute one of the acting person's OWN entries. A thin server-action wrapper over the
// factory: it re-derives the verified session (never trusting a client value), takes the
// entry seq + note from the form, disputes scoped to the SESSION user id, and redirects
// back with a notice naming the outcome — a refusal (another person's / a missing entry)
// or a malformed id is shown in plain words, never swallowed (the screen must not fail
// silently). The actor is always the session, never a form-supplied id (design §5).
async function disputeEntryAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const config = loadConfig();
  const seq = Number(formData.get("seq"));
  const note = String(formData.get("note") ?? "");
  let outcome: unknown;
  try {
    outcome = await buildActions(db, config.nodeEnv, config.devKek).disputeEntry(session, seq, note);
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/activity");
  redirect(noticeLocation("dispute_filed", outcome));
}

// The outcome of the last change, in words plus an icon (never colour alone). A problem is
// announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: ActivityNotice }) {
  const Icon = notice.tone === "done" ? CheckCircle2 : AlertTriangle;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6">
      <div
        role={notice.tone === "done" ? "status" : "alert"}
        className="flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-sm text-fg"
      >
        <Icon aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0" />
        <p>{notice.text}</p>
      </div>
    </div>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const rawNotice = params.notice;
  const notice = activityNotice(typeof rawNotice === "string" ? rawNotice : undefined);
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const config = loadConfig();
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }

  const view = await buildActions(db, config.nodeEnv, config.devKek).load(session, params);
  return (
    <>
      {notice ? <NoticeBanner notice={notice} /> : null}
      <ActivityView {...view} disputeAction={disputeEntryAction} />
    </>
  );
}
