import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice as InlineNotice } from "@/components/ui/notice";

import { ActivityView } from "@/components/activity/activity-view";
import { loadConfig, type Config } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { getUserById } from "@/server/db/users";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { createRedactingRecorder } from "@/server/mcp/recorder";
import { createDisputeRepo } from "@/server/activity/disputes";
import { createUndoService } from "@/server/activity/undo";
import { createAgentExecutors } from "@/server/mcp/compose";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import { systemClock } from "@/server/seams/clock";
import { reversalToolFor } from "@/server/activity/tool-effects";
import type { Db } from "@/server/db/index";
import { createActivityActions } from "./actions";
import { noticeLocation, activityNotice, type ActivityNotice } from "./notices";
import type { Metadata } from "next";

// The page title (review fix G8, WCAG 2.4.2): "%s · Warthog" via the root template.
export const metadata: Metadata = { title: "Activity" };

// E08-S10 — Activity page (the thin protected-page loader + Dispute/Undo wiring).
//
// The loader triad: this async `page.tsx` reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the tested
// `createActivityActions` seam's `load`) into the <ActivityView> props — the person's
// OWN entries, newest-first, narrowed by the view's filters/search — and renders the
// view. The record-wide Check-integrity control posts `verify=1`, which `load` runs.
//
// E08-S09 shipped Dispute/Undo as forms that posted nowhere (dead controls). Both are now
// bound to inline `use server` wrappers (the sibling security screen's pattern) that
// re-derive the session, call `disputeEntry` / `undoEntry`, and redirect back with a
// `?notice=` outcome the page renders in plain words. Reversal EXECUTION is wired through
// the MCP composition root (`createAgentExecutors().runReversal`, E07-S20), so a reversible
// entry's Undo is a LIVE control that runs the declared reversal once and reports its
// outcome; an entry whose tool declares no reversal shows no Undo at all (`canUndo` false).
//
// Thin by design (the server-composition-roots addendum): per-request data (the cookie,
// the search params) is read BEFORE `getServerDb()` so touching it marks the page dynamic
// and `next build` never prerenders it or opens the database at build time; config is read
// inside the handler (`loadConfig()`), never at module load; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed.
// The `(protected)` layout already wraps every page in the app shell (PortalChrome).

const SESSION_COOKIE = "__Host-wh_session";

// The declared reversals (design §7) come from the curated connector definitions (a created
// calendar event is undone by deleting it). ONE table backs both the loader's `canUndo` and
// the undo service's "is this reversible?" decision, so an Undo control shows only where
// undoEntry can act.
const reversalFor = reversalToolFor;

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
function buildActions(db: Db, config: Config) {
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
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
    recorder: createRedactingRecorder({ db, clock: systemClock, dekFor }),
    reversalFor,
    // The reversal executor routes the declared reversal tool through the agent-call
    // pipeline, composed by the MCP composition root (`createAgentExecutors`): it reports
    // the outcome in plain words rather than throwing, so the undo service can always record
    // the reversal entry (E07-S20). The page binds a live undoAction over it below.
    runReversal: createAgentExecutors({ db, config }).runReversal,
  });

  // Connected services are named through the process-wide connector catalogue, the same
  // index the connectors screen reads.
  const serviceName = (connectorId: string): string | undefined => getProcessCatalogue().get(connectorId)?.name;

  return createActivityActions({ db, disputes, undo, keyWrapper, reversalFor, serviceName, clock: systemClock });
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
    outcome = await buildActions(db, config).disputeEntry(session, seq, note);
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/activity");
  redirect(noticeLocation("dispute_filed", outcome, seq));
}

// Undo one of the acting person's OWN reversible entries. Same discipline as dispute: it
// re-derives the verified session (never a client value, design §5), takes the entry seq
// from the form, undoes scoped to the SESSION user id — which runs the declared reversal
// through the pipeline and records a new reversal entry — and redirects back with a notice
// naming the outcome. An entry that is not this person's or declares no reversal is a
// reported refusal, and a malformed seq is a boundary 4xx, each shown in plain words.
async function undoEntryAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const config = loadConfig();
  const seq = Number(formData.get("seq"));
  let outcome: unknown;
  try {
    outcome = await buildActions(db, config).undoEntry(session, seq);
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/activity");
  // Back to the new reversal entry on success, else to the entry the person tried to undo.
  const landing = outcome && typeof outcome === "object" && "ok" in outcome && outcome.ok && "entry" in outcome
    ? (outcome as { entry: { seq: number } }).entry.seq
    : seq;
  redirect(noticeLocation("undo_done", outcome, landing));
}

// The outcome of the last change, in words plus an icon (never colour alone). A problem is
// announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: ActivityNotice }) {
  return (
    <div className="wh-page pb-0">
      <InlineNotice tone={notice.tone === "done" ? "success" : notice.tone === "waiting" ? "info" : "error"}>
        {notice.text}{notice.action && <> <a href={notice.action.href} className="font-medium underline underline-offset-4">{notice.action.label}</a></>}
      </InlineNotice>
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

  const view = await buildActions(db, config).load(session, params);
  return (
    <>
      {notice ? <NoticeBanner notice={notice} /> : null}
      <ActivityView {...view} disputeAction={disputeEntryAction} undoAction={undoEntryAction} />
    </>
  );
}
