import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice as InlineNotice } from "@/components/ui/notice";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { getUserById } from "@/server/db/users";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { releaseStore } from "@/server/crypto/release-store";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createAgentsActions, type AgentsActions } from "./actions";
import { AgentsScreen } from "./disconnect-confirm";

// E10-S11 — Agents list page (the thin protected-page loader + disconnect wiring over the
// tested `createAgentsActions` seam, `./actions`).
//
// The loader triad: this async `page.tsx` reads the signed-in session from the host-locked
// `__Host-wh_session` cookie, turns it (via the seam's `load`) into the person's OWN agents
// — the list-all read, member-scoped — and mounts <AgentListView> (via the `"use client"`
// AgentsScreen that gates Disconnect behind a single confirm). An un-mounted disconnect
// ships nothing, so each agent carries a LIVE Disconnect bound to the server action.
//
// Disconnect goes through the SAME seam: `disconnectAction` re-derives the verified session
// (never trusting a client value for identity), takes the agent id from the submitted form,
// disconnects scoped to the SESSION user, and redirects back with a `?notice=` outcome the
// page renders in plain words (the sibling activity screen's pattern) — never failing
// silently. A malformed / oversized id throws a 4xx `HttpError` at the seam's boundary,
// caught here and reported as a plain problem rather than a crash; a genuine fault rethrows.
//
// Thin by design (the server-composition-roots addendum): per-request data (the cookie, the
// search params) is read BEFORE `getServerDb()` so touching it marks the page dynamic and
// `next build` never prerenders it or opens the database at build time; config is read
// inside the handler (`loadConfig()`), never at module load; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed; the
// release store is the process-wide singleton. The `(protected)` layout already wraps every
// page in the app shell (PortalChrome).

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is needed
// so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the agents actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets `dekFor` unwrap the session person's own DEK
// (the disconnect's activity write + approval denial encrypt/decrypt under it).
function buildActions(db: Db, nodeEnv: string, devKek: Uint8Array | undefined): AgentsActions {
  const keyWrapper = selectKeyWrapper({ nodeEnv, localKek: devKek });
  const dekFor = async (userId: string): Promise<Uint8Array> => {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  };
  return createAgentsActions({ db, clock: systemClock, releaseStore, dekFor });
}

// Disconnect one of the acting person's OWN agents. A thin `use server` wrapper over the
// factory: re-derive the verified session (never trusting a client value), take the agent
// id from the submitted form, disconnect scoped to the session user, and redirect back with
// a notice naming the outcome — a refusal or a malformed id is shown in plain words, never
// swallowed.
async function disconnectAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const raw = formData.get("agentId");
  const agentId = typeof raw === "string" ? raw : "";
  const config = loadConfig();
  let notice = "disconnected";
  try {
    const result = await buildActions(db, config.nodeEnv, config.devKek).disconnect(session, agentId);
    if (!result.ok) {
      notice = "problem";
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    notice = "problem";
  }
  revalidatePath("/agents");
  redirect(`/agents?notice=${notice}`);
}

// The outcome of the last disconnect, in words plus an icon (never colour alone). A problem
// is announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: "disconnected" | "problem" }) {
  const done = notice === "disconnected";
  const text = done ? "Agent disconnected." : "We couldn't disconnect that agent. Please try again.";
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6">
      <InlineNotice tone={done ? "success" : "error"}>{text}</InlineNotice>
    </div>
  );
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const rawNotice = params.notice;
  const notice =
    rawNotice === "disconnected" || rawNotice === "problem" ? rawNotice : null;
  const config = loadConfig();
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const view = await buildActions(db, config.nodeEnv, config.devKek).load(session);
  return (
    <>
      {notice ? <NoticeBanner notice={notice} /> : null}
      <AgentsScreen agents={view.agents} disconnect={disconnectAction} />
    </>
  );
}
