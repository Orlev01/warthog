import { notificationSenders } from "../../../../../server/notify/production";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { DataView } from "@/components/settings/data-view";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { verifySession, COOKIE_NAME, type Session } from "@/server/auth/session";
import { requireStepUp } from "@/server/auth/step-up";
import { createResetExecutor } from "@/server/account/reset-executor";
import { systemClock } from "@/server/seams/clock";
import { selectSenders, type Senders, type OutgoingMessage } from "@/server/notify/senders";
import { HttpError } from "@/server/http/validate";
import type { DeletionExecutor } from "@/server/account/delete";
import type { Db } from "@/server/db/index";
import { createDataActions, DELETE_ACCOUNT_CONFIRMATION, type ActionResult } from "./actions";
import type { Metadata } from "next";

// The page title (review fix G8, WCAG 2.4.2): "%s · Warthog" via the root template.
export const metadata: Metadata = { title: "Data & privacy" };

// E16-S11 — Data & privacy page (the thin protected-page loader over the tested
// `createDataActions` seam, `./actions`) wired to its controls.
//
// The loader reads the signed-in session from the host-locked `__Host-wh_session` cookie,
// turns it (via the seam's `load`) into the session person's OWN imported-history archive,
// and mounts the render-tested <DataView/> (E16-S10) WIRED to the three data actions:
// export (after a fresh step-up — a native POST to the sibling `export/route.ts`, which
// answers with the file itself; review fix G2), import a previous export, and delete the
// account (after a fresh step-up AND the typed confirmation phrase). While the session has
// no fresh step-up, an inline "Confirm it's you" (review fix G3) is offered so a refused
// export or delete is never a dead end. The view is fed the
// SAME `DELETE_ACCOUNT_CONFIRMATION` the delete action checks, so the gate on screen and
// the server-side check never drift (one source of truth).
//
// Wiring follows the security / notifications precedent: each control submits a
// <form action={…}>; a thin `"use server"` wrapper re-derives the verified session (never
// trusting a client value), calls the seam member-scoped to that session person, and
// redirects back with a `?notice=` code this page maps to plain words — a refusal (no fresh
// step-up, a wrong/absent confirmation) or a boundary 4xx is shown, never swallowed (no
// silent failure).
//
// Thin by design (the server-composition-roots addendum): per-request data (the session
// cookie, the `?notice=` search param) is read BEFORE `getServerDb()` so `next build` marks
// the page dynamic and never prerenders it or opens the database at build time; config is
// read INSIDE each handler (`loadConfig()`), never at module load; the database comes from
// the process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed.
// Config and secrets flow only through `loadConfig()` (INV-103).

const SCREEN = "/settings/data";

// Real senders stand-in: until the Azure channel senders are built, sending through one
// rejects loudly rather than dropping the message (constitution: never fail silently).
// With dev tooling on, `selectSenders` routes every channel to the dev outbox instead —
// so the delete confirmation email is readable at `/dev/outbox` in dev.


// The cross-aggregate revoke the deletion service delegates (cut off every agent + service
// connection): the production executor over the db (`createResetExecutor`'s transactional
// revokeAgentsAndConnections — the same revoke a completed account reset runs). Review fix
// G2: this used to be null, so every delete was refused while the button looked live.
function deletionRevokerFor(db: Db): DeletionExecutor {
  return createResetExecutor(db);
}

// Build the data actions with the real seams. The KeyWrapper (local AES outside production,
// Key Vault in production) lets the actions resolve the session person's own DEK to read /
// restore their DEK-encrypted content; the configured senders (the dev outbox in dev) carry
// the delete confirmation email.
function buildActions(db: Db, revoker: DeletionExecutor = deletionRevokerFor(db)) {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  return createDataActions({
    db,
    clock: systemClock,
    keyWrapper,
    revoker,
    senders: notificationSenders(config, db),
  });
}

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Where a finished form action sends the person: back to the screen with the success code,
// the refusal's reason, or `invalid_request` for a boundary 4xx. Anything else is a genuine
// server fault and is rethrown, never dressed up as a notice (mirrors the security screen).
function noticeLocation(successCode: string, outcome: ActionResult | unknown): string {
  if (outcome instanceof HttpError) return `${SCREEN}?notice=invalid_request`;
  if (outcome instanceof Error) throw outcome;
  const result = outcome as ActionResult;
  const code = result.ok ? successCode : result.reason;
  return `${SCREEN}?notice=${encodeURIComponent(code)}`;
}

// --- the wired server actions (thin wrappers over the tested seam) ----------------------
//
// Export and import run through the device-local transfer controls.

// Delete the session person's account — after a fresh step-up AND the typed confirmation
// phrase (the seam enforces both). The deletion service shreds the DEK, revokes every agent
// and connection, ends every session and enqueues the purge.
async function deleteAccountAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).deleteAccount(session, {
      confirmation: String(formData.get("confirmation") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  // On success the account is gone and every session row with it — drop this browser's
  // (now dead) host-locked cookie and send the person to sign-in; otherwise report the
  // refusal reason on this screen.
  if ((outcome as ActionResult | undefined)?.ok) {
    (await cookies()).set(COOKIE_NAME, "", {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
    });
    redirect("/signin");
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("account_deleted", outcome));
}

// --- the outcome notice (plain words + an icon, never colour alone) -------------------

type Notice = { tone: "done" | "problem"; text: string };

// Plain Australian English, no protocol jargon (brief design_ux.copy). Unknown codes render
// nothing, so the query string can never inject copy onto the screen.
const NOTICES: Record<string, Notice> = {
  imported: {
    tone: "done",
    text: "Your export file has been imported — its history is in the archive below.",
  },
  step_up_required: {
    tone: "problem",
    text: "That's a sensitive action, so we need to check it's you first. Choose “Confirm it's you” below, then try again.",
  },
  confirmation_required: {
    tone: "problem",
    text: "Nothing was deleted: type the exact confirmation phrase to confirm.",
  },
  owns_household: {
    tone: "problem",
    text: "Nothing was deleted: transfer or close the household you own first, then try again.",
  },
  invalid_request: {
    tone: "problem",
    text: "Nothing was changed: that file or request wasn't valid. Please try again.",
  },
};

function dataNotice(code: string | undefined): Notice | null {
  return (code !== undefined && Object.hasOwn(NOTICES, code) && NOTICES[code]) || null;
}

function NoticeBanner({ notice }: { notice: Notice }) {
  const Icon = notice.tone === "done" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={notice.tone === "done" ? "status" : "alert"}
      className="flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-sm text-fg"
    >
      <Icon aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0" />
      <p>{notice.text}</p>
    </div>
  );
}

export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const rawNotice = (await searchParams).notice;
  const notice = dataNotice(typeof rawNotice === "string" ? rawNotice : undefined);
  const token = (await cookies()).get(COOKIE_NAME)?.value ?? null;
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }

  const data = await buildActions(db).load(session);
  // Export and delete need a confirmation within the last five minutes; offer it inline
  // whenever the session lacks one, so a refusal is never a dead end.
  const needsConfirm = !requireStepUp(session, { clock: systemClock });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Data &amp; privacy</h1>
        <p className="text-sm text-fg-muted">
          Export everything Warthog keeps about you, bring back a previous export, or delete
          your account.
        </p>
      </div>
      {notice ? <NoticeBanner notice={notice} /> : null}
      {needsConfirm ? (
        <ConfirmItsYou
          explanation="Exporting, importing or deleting data needs a quick check that it's really you. Use a passkey or authenticator code."
          confirmedText="Thanks — that's confirmed. You can transfer data or delete your account for the next five minutes."
        />
      ) : null}
      <DataView
        importedHistory={data.importedHistory}
        confirmationPhrase={DELETE_ACCOUNT_CONFIRMATION}
        deleteAccountAction={deleteAccountAction}
      />
    </div>
  );
}
