import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice as InlineNotice } from "@/components/ui/notice";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createSpendingActions, type SpendingActions } from "./actions";
import { SpendingView } from "@/components/spending/spending-view";

// E15-S11 — Spending page (the thin protected-page loader + action wiring over the
// tested `createSpendingActions` seam, `./actions`). It reads the signed-in session from
// the host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into the
// person's OWN-agent spending detail + their household totals + their account currency +
// the selectable options, and mounts the already-render-tested <SpendingView/>. The
// view's account-currency form is BOUND to a `use server` wrapper over the SAME seam: it
// re-derives the verified session (never trusting a client value for identity), takes the
// chosen code from the submitted form, persists it member-scoped, and redirects back with
// a `?notice=` the page renders in plain words — a refusal or a 4xx from the boundary is
// reported as a plain problem, never swallowed (no dead controls, no silent failure).
//
// Thin by design (the server-composition-roots addendum): per-request data (the search
// params, the cookie) is read BEFORE `getServerDb()`, so `next build` marks the page
// dynamic and never prerenders it or opens the database at build time; config is read
// INSIDE the handler (`loadConfig()`), never at module load; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed.
// The `(protected)` layout already guards every page. Config and secrets flow only
// through `loadConfig()` (INV-103) — this entry reads no `process.env` of its own, and the
// seam holds no secret (db, clock and KeyWrapper are injected).

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the spending actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) unwraps the session person's own DEK for the
// own-spending read; the system clock supplies the period bucket to the spending reads.
function buildActions(db: Db): SpendingActions {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  return createSpendingActions({ db, clock: systemClock, keyWrapper });
}

type Notice = "saved" | "problem";

const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  saved: { done: true, text: "Account currency saved." },
  problem: { done: false, text: "That currency could not be saved. Please choose another." },
};

function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && raw in NOTICES ? (raw as Notice) : null;
}

// Persist the chosen account currency through the seam under the verified session, then
// redirect back with a notice naming the outcome. A reported refusal ({ ok: false }) or a
// 4xx `HttpError` from the validation boundary becomes `problem` — shown in plain words,
// never swallowed; a genuine fault rethrows.
async function setCurrencyAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const raw = formData.get("account-currency");
  const currency = typeof raw === "string" ? raw : "";
  let notice: Notice = "saved";
  try {
    const result = await buildActions(db).setAccountCurrency(session, { currency });
    if (!result.ok) {
      notice = "problem";
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    notice = "problem";
  }
  revalidatePath("/spending");
  redirect(`/spending?notice=${notice}`);
}

// The outcome of the last set, in words plus an icon (never colour alone). A problem is
// announced immediately (alert); a success politely (status). The view shows it under
// its header, next to the currency setting it reports on.
function NoticeBanner({ notice }: { notice: Notice }) {
  const { done, text } = NOTICES[notice];
  return <InlineNotice tone={done ? "success" : "error"}>{text}</InlineNotice>;
}

export default async function SpendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const notice = toNotice(params.notice);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const data = await buildActions(db).load(session);

  // The view renders the account-currency setting as one compact form in its header,
  // its Save bound to `setCurrencyAction` — never a dead control.
  return (
    <SpendingView
      own={data.own}
      household={data.household}
      accountCurrency={data.accountCurrency}
      currencyOptions={data.currencyOptions}
      currencyAction={setCurrencyAction}
      notice={notice ? <NoticeBanner notice={notice} /> : null}
    />
  );
}
