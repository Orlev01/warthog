import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { InboxView } from "@/components/inbox/inbox-view";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { verifySession, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { recordMetricEvent } from "@/server/metrics/record";
import type { Db } from "@/server/db/index";
import { createAgentExecutors } from "@/server/mcp/compose";
import { createInboxActions, type ActionResult } from "./actions";

// E12-S13 — Inbox page (the thin protected-page loader + decision wiring).
//
// The loader triad: this async `page.tsx` reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the tested `createInboxActions`
// seam's `load`) into the <InboxView> props — the person's OWN pending approvals
// (newest-first) + their decision history, each pending request's release kind, and a
// card release's saved-card picker — and renders the view. Viewing marks every pending
// approval OPENED, suppressing its SMS/email fallback.
//
// It binds the three decision controls to inline `use server` wrappers (the sibling
// activity screen's pattern): each re-derives the verified session (never a client
// value, design §5), calls the factory, and redirects back with a `?notice=` outcome the
// page shows in plain words (never a silent failure). A card/high-tier RELEASE's Approve
// is the on-device unlock-decrypt-release flow, which <InboxView> mounts as its own live
// <ReleaseApprove> client control (E11-S17) — a server page cannot hand a client a
// callback, so a release is live by construction, not bound here. Approving a held
// NON-release call runs it exactly once through the agent-call
// pipeline, composed by `createAgentExecutors` (the MCP composition root): its outcome is
// recorded in Activity and the approve wrapper reports it in plain words (E07-S20).
//
// Thin by design (the server-composition-roots addendum): per-request data (the cookie,
// the search params) is read BEFORE `getServerDb()` so touching it marks the page dynamic
// and `next build` never prerenders it or opens the database at build time; config is read
// inside the handler (`loadConfig()`), never at module load; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed.
// The `(protected)` layout already wraps every page in the app shell (PortalChrome).

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the inbox actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets `load` resolve the session person's DEK to
// decrypt their own approval detail; `executeApprovedHold` comes from the MCP composition
// root (`createAgentExecutors`), so approving a held non-release call runs it exactly once
// through the agent-call pipeline instead of the old "not configured" stub (E07-S20).
function buildActions(db: Db) {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const { executeApprovedHold } = createAgentExecutors({ db, config });
  return createInboxActions({
    db,
    clock: systemClock,
    keyWrapper,
    executeApprovedHold,
    // Decision counts and response times reach the metrics store (review fix D2).
    recordMetric: (input) => recordMetricEvent(db, systemClock, input),
  });
}

// Map a decision outcome (or a thrown error) to a stable notice code the page turns into
// plain words. A refusal names its reason; anything unexpected is a generic problem.
function decisionNotice(outcome: ActionResult | unknown, doneCode: string): string {
  if (outcome && typeof outcome === "object" && "ok" in outcome) {
    const result = outcome as ActionResult;
    if (result.ok) return doneCode;
    if (result.reason === "step_up_required") return "step_up";
    if (result.reason === "not_found") return "not_found";
    if (result.reason === "already_decided") return "already_decided";
    if (result.reason === "expired") return "expired";
    if (result.reason === "approved_not_run") return "approved_not_run";
  }
  return "error";
}

// Approve one of the acting person's OWN pending approvals. A thin server-action wrapper:
// re-derive the verified session (never a client value), take the approval id from the
// form, decide scoped to the SESSION user id, and redirect back with a notice naming the
// outcome — a refusal, a malformed id or an unwired executor is shown in plain words.
async function approveAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).approveApproval(session, String(formData.get("id") ?? ""));
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/inbox");
  redirect(`/inbox?notice=${decisionNotice(outcome, "approved")}`);
}

// Deny one of the acting person's OWN pending approvals. Same discipline as above.
async function denyAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).denyApproval(session, String(formData.get("id") ?? ""));
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/inbox");
  redirect(`/inbox?notice=${decisionNotice(outcome, "denied")}`);
}

// Ask the agent for more detail on one of the acting person's OWN pending approvals,
// recording the person's question. Same discipline as above.
async function moreDetailAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).askForMoreDetail(
      session,
      String(formData.get("id") ?? ""),
      String(formData.get("question") ?? ""),
    );
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/inbox");
  redirect(`/inbox?notice=${decisionNotice(outcome, "asked")}`);
}

// The outcome of the last decision, in words plus an icon (never colour alone). A problem
// is announced immediately (alert); a success politely (status).
type Notice = { tone: "done" | "problem"; text: string };
const NOTICES: Record<string, Notice> = {
  approved: { tone: "done", text: "Approved — the agent can go ahead." },
  denied: { tone: "done", text: "Turned down — the agent won't go ahead." },
  asked: { tone: "done", text: "We've asked the agent for more detail." },
  not_found: {
    tone: "problem",
    text: "We couldn't find that request. It may have already been decided.",
  },
  already_decided: {
    tone: "problem",
    text: "That request was already decided, so nothing more was done.",
  },
  approved_not_run: {
    tone: "problem",
    text: "Approved, but Warthog couldn't carry out the request, so nothing was done. The agent has been told.",
  },
  expired: {
    tone: "problem",
    text: "That request expired before you decided, so the agent won't go ahead.",
  },
  step_up: { tone: "problem", text: "Please confirm it's you first, then try again." },
  error: { tone: "problem", text: "We couldn't complete that just now. Please try again." },
};

function NoticeBanner({ notice }: { notice: Notice }) {
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

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const rawNotice = (await searchParams).notice;
  const notice = typeof rawNotice === "string" ? (NOTICES[rawNotice] ?? null) : null;
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const view = await buildActions(db).load(session);
  return (
    <>
      {notice ? <NoticeBanner notice={notice} /> : null}
      <InboxView
        {...view}
        approveAction={approveAction}
        denyAction={denyAction}
        moreDetailAction={moreDetailAction}
      />
    </>
  );
}
