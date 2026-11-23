import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { getProcessCatalogue } from "../../../server/connectors/catalogue";
import { notificationSenders } from "../../../server/notify/production";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ConsentView, type ConsentDecisionResult } from "@/components/agents/consent-view";
import { Notice } from "@/components/ui/notice";
import { ConnectionFrame, ExpiredConnection } from "@/components/agents/connection-frame";

import { loadConfig } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { verifySession, type Session } from "../../../server/auth/session";
import { systemClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";
import { HttpError } from "../../../server/http/validate";
import { systemClientResolver } from "../../../server/oauth/clients";
import { type CatalogueIndex } from "../../../server/connectors/catalogue";
import { createAuthorizeActions } from "../authorize/actions";
import { approvalFromForm, loadConsentView } from "./actions";
import { confirmFactors } from "@/server/auth/confirm-factors";
import type { Db } from "../../../server/db/index";

// E10-S12 — the consent screen (loader + view + decision server-action wrappers).
//
// After a signed-in person's valid authorize request is carried here server-side
// (`beginAuthorization`, with the opaque handle in the host-locked `__Host-wh_consent`
// cookie), this thin page resolves the pending request by that handle (NEVER from the
// form), renders the prop-driven <ConsentView>, and wires Approve/Refuse to the tested
// consent decision. The acting person comes from the session cookie and the pending
// request from the cookie's handle — the form carries only the person's choices. Config
// is read inside the handler (`loadConfig()`), never at module load, and the database
// comes from `getServerDb()` (one migrated database per process). No outcome is
// swallowed: a failure comes back as a plain-words notice.

const SESSION_COOKIE = "__Host-wh_session";
const CONSENT_COOKIE = "__Host-wh_consent";
// A session that lapses mid-consent signs in and comes straight back here: the pending
// handle cookie outlives the sign-in (review fix A4). A fixed, relative path.
const SIGN_IN_AND_RETURN = `/signin?next=${encodeURIComponent("/oauth/consent")}`;

// Clear the pending-handle cookie once a decision has consumed the request (host-locked,
// so the clear must carry the same attributes the route set it with).
const CLEAR_CONSENT_COOKIE = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: 0,
} as const;

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Real senders stand-in: until the Azure channel senders are built, sending through one
// rejects loudly rather than dropping the message (constitution: never fail silently).
// With dev tooling on, `selectSenders` routes every channel to the dev outbox instead.


// Build the consent decision actions with the real seams (the client resolver re-checks
// the client and its registered redirect URI before either decision redirects; the
// configured email sender carries the new-agent-connection alert).
function buildActions(db: Db) {
  const config = loadConfig();
  return createAuthorizeActions({
    keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }),
    db,
    config,
    clock: systemClock,
    random: systemRandom,
    resolveClient: systemClientResolver(db),
    alerts: { emailSender: notificationSenders(config, db).email },
  });
}

// The connector catalogue (the same process-wide index the connectors screen builds), so
// the person's connected services are named on the consent screen as they are elsewhere.
function getCatalogue(): CatalogueIndex { return getProcessCatalogue(loadConfig()); }

// Approve the consent: re-derive the verified session (never trusting a client value),
// take the pending request from the cookie handle, and run the tested decision — which
// names the agent, creates its connection + permissions and issues the code. On success
// the pending handle is cleared and the person is redirected back to the client; a
// malformed submission comes back as a notice with the pending request still usable; an
// expired/unknown handle comes back as an expired notice.
async function approveConsentAction(formData: FormData): Promise<ConsentDecisionResult> {
  "use server";
  const db = await getServerDb();
  const store = await cookies();
  const session = await resolveSession(db);
  if (!session) redirect(SIGN_IN_AND_RETURN);

  const handle = store.get(CONSENT_COOKIE)?.value ?? "";
  const view = await loadConsentView(handle, session.userId);
  const platform = view?.platform ?? "Agent";

  let clientRedirect: string | null = null;
  let consumed = false;
  let notice = "expired";
  try {
    const result = await buildActions(db).approve(session, handle, approvalFromForm(formData, platform), String(formData.get("request") ?? ""));
    // Confirm it's you first: nothing was used up, and the view approves straight after.
    if (!result.ok && result.error === "step_up_required") return { stepUpRequired: true };
    // The screen was for a different request than the one in progress now (another tab or
    // site started one): nothing was used up; show the current one to review.
    if (!result.ok && result.error === "request_changed") notice = "changed";
    else consumed = true;
    if (result.ok) clientRedirect = result.redirectTo;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // Malformed input: the decision rejects at the boundary BEFORE consuming the pending
    // request, so the handle is still usable — keep the cookie and let the person retry.
    return { error: "We couldn’t use those details. Check the agent name and card budget, then try again. Your choices have been kept." };
  }

  if (consumed) store.set(CONSENT_COOKIE, "", CLEAR_CONSENT_COOKIE);
  if (clientRedirect) redirect(clientRedirect);
  redirect(`/oauth/consent?notice=${notice}`);
}

// Refuse the consent: take the pending request from the cookie handle and run the tested
// decision, which creates nothing and redirects back to the client with access_denied.
async function refuseConsentAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const store = await cookies();
  const session = await resolveSession(db);
  if (!session) redirect(SIGN_IN_AND_RETURN);

  const handle = store.get(CONSENT_COOKIE)?.value ?? "";
  const result = await buildActions(db).refuse(session, handle, String(formData.get("request") ?? ""));

  // A Deny from a screen for another request leaves the current one in place to review.
  if (!result.ok && result.error === "request_changed") redirect("/oauth/consent?notice=changed");
  store.set(CONSENT_COOKIE, "", CLEAR_CONSENT_COOKIE);
  if (result.ok) redirect(result.redirectTo);
  redirect("/oauth/consent?notice=expired");
}

// The outcome of the last attempt, in plain Australian English.
const NOTICES: Record<string, string> = {
  invalid: "We couldn’t use those details. Check the agent name and card budget, then try again.",
  expired: "This connection request has expired. Start connecting again from your agent.",
  changed: "Another connection request was started in this browser, so nothing was connected. This is the request in progress now. Only approve it if you started it and recognise it.",
};

// Shown when the pending request can't be found (an expired or already-used handle), so
// the screen explains it rather than crashing.
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const rawNotice = (await searchParams).notice;
  const noticeText = typeof rawNotice === "string" ? NOTICES[rawNotice] ?? null : null;

  // The consent screen is the signed-in person's: a lapsed session signs in and returns
  // here (the pending-handle cookie outlives it), and the services offered are their own.
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect(SIGN_IN_AND_RETURN);

  const store = await cookies();
  const handle = store.get(CONSENT_COOKIE)?.value ?? "";
  const view = await loadConsentView(handle, session.userId, {
    db,
    nameOf: (connectorId) => getCatalogue().get(connectorId)?.name,
  });
  if (!view) return <ExpiredConnection />;
  const factors = await confirmFactors(db, session.userId);

  return (
    <ConnectionFrame>
      {/* The frame spaces its children, so the notice never sits flush on the form (public-21). */}
      {noticeText ? <Notice tone="error">{noticeText}</Notice> : null}
      <ConsentView
        {...view}
        confirm={factors}
        approveAction={approveConsentAction}
        refuseAction={refuseConsentAction}
      />
    </ConnectionFrame>
  );
}
