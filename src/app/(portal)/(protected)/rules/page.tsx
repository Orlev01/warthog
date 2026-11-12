import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice as InlineNotice } from "@/components/ui/notice";

import { RulesView } from "@/components/rules/rules-view";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { verifySession, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import type { Db } from "@/server/db/index";
import {
  createRulesActions,
  ruleInputFromForm,
  rulesNotice,
  rulesPageState,
  rulesReturnHref,
  type ActionResult,
  type RulesNotice,
} from "./actions";

// E12-S17 — Rules page (the thin protected-page loader + rule-action wiring).
//
// The loader triad: this async `page.tsx` reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the tested
// `createRulesActions` seam's `load`) into the <RulesView> data — the person's OWN
// rules (active and paused), each as its exact plain sentence + status, and their
// connected agents — and renders the view.
//
// It binds the four rule controls to inline `use server` wrappers (the sibling inbox
// screen's pattern): each re-derives the verified session (never a client value,
// design §5), calls the factory scoped to the SESSION user id, and redirects back
// with a `?notice=` outcome the page shows in plain words (never a silent failure —
// a refusal, a malformed id, or a rejected vocabulary is shown, not swallowed).
//
// Where each action lands (`rulesReturnHref`, validated keys only): adding a rule returns
// to the New rule view (its draft is still mounted, so a refusal can be corrected); pause
// and delete return to the status filter the row's form carried; the rules list is the
// default view.
//
// Thin by design (the server-composition-roots addendum): per-request data (the
// cookie, the search params) is read BEFORE `getServerDb()` so touching it marks the
// page dynamic and `next build` never prerenders it or opens the database at build
// time; config is read inside the handler (`loadConfig()`), never at module load; the
// database comes from the process-wide `getServerDb()`, never `createDb`, and the
// shared handle is never closed. The `(protected)` layout already wraps every page in
// the app shell.

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the rules actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets `load`/`createRule` resolve the session
// person's DEK to decrypt/encrypt a rule's condition.
function buildActions(db: Db) {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  return createRulesActions({ db, clock: systemClock, keyWrapper });
}

// Map a mutation outcome (or a thrown error) to a stable notice code the page turns
// into plain words. A refusal names its reason; a 4xx from the validation boundary
// is shown as "invalid"; anything else is a generic problem.
function mutationNotice(outcome: ActionResult | unknown, doneCode: string): string {
  if (outcome && typeof outcome === "object" && "ok" in outcome) {
    const result = outcome as ActionResult;
    if (result.ok) return doneCode;
    if (result.reason === "not_found") return "not_found";
    return "error";
  }
  if (outcome && typeof outcome === "object" && "status" in outcome) {
    const status = (outcome as { status: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) return "invalid";
  }
  return "error";
}

// Create a new rule from the submitted form. A thin server-action wrapper: re-derive
// the verified session (never a client value), map the FormData to a rule input, and
// store it scoped to the SESSION user id — a refusal or a rejected vocabulary is
// shown in plain words.
async function createAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).createRule(session, ruleInputFromForm(formData));
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/rules");
  redirect(rulesReturnHref(mutationNotice(outcome, "created"), { view: "new" }));
}

// Replace the content of one of the acting person's OWN rules. Same discipline.
async function updateAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).updateRule(
      session,
      String(formData.get("rule-id") ?? ""),
      ruleInputFromForm(formData),
    );
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/rules");
  redirect(rulesReturnHref(mutationNotice(outcome, "updated"), {}));
}

// Pause one of the acting person's OWN rules. Same discipline.
async function pauseAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).pauseRule(session, String(formData.get("rule-id") ?? ""));
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/rules");
  redirect(rulesReturnHref(mutationNotice(outcome, "paused"), { status: formData.get("return-status") }));
}

// Delete one of the acting person's OWN rules. Same discipline.
async function deleteAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).deleteRule(session, String(formData.get("rule-id") ?? ""));
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/rules");
  redirect(rulesReturnHref(mutationNotice(outcome, "deleted"), { status: formData.get("return-status") }));
}

// The outcome of the last change, in words plus an icon (never colour alone). A
// problem is announced immediately (alert); a success politely (status). The copy is
// resolved by the sibling `rulesNotice` seam (one source of truth) — this page holds
// no copy of its own.
function NoticeBanner({ notice }: { notice: RulesNotice }) {
  return (
    <InlineNotice tone={notice.tone === "done" ? "success" : "error"}>{notice.text}</InlineNotice>
  );
}

export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const state = rulesPageState(await searchParams);
  const notice = rulesNotice(state.notice);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const view = await buildActions(db).load(session);
  return (
    <div className="wh-page wh-page--reading flex flex-col gap-6">
      {notice ? <NoticeBanner notice={notice} /> : null}
      <RulesView
        rules={view.rules}
        agents={view.agents}
        currency={view.currency}
        initialView={state.view}
        statusFilter={state.status}
        createAction={createAction}
        updateAction={updateAction}
        pauseAction={pauseAction}
        deleteAction={deleteAction}
      />
    </div>
  );
}
