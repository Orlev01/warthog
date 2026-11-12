import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { SignInRequestsView } from "@/components/settings/sign-in-requests-view";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { loadConfig } from "@/server/config";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { timeZoneFor } from "@/server/spending/time-zone";
import { getUserById } from "@/server/db/users";
import type { Db } from "@/server/db/index";
import { createSignInRequestActions, signInRequestNotice, type SignInRequestResult } from "./actions";

// Settings › Security › Sign-in requests (follow-up S3) — the thin protected loader. It reads
// the signed-in session from the host-locked cookie, lists that member's OWN waiting
// "approve from another device" requests through the tested seam (./actions), and renders the
// view. The approve / deny server actions re-derive the session for every call, so the
// approval id from the page can only ever reach the session's own requests. Config is read
// per request, never at module load.

export const metadata: Metadata = { title: "Sign-in requests" };

const SESSION_COOKIE = "__Host-wh_session";

async function resolveSession(db: Db): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

function buildActions(db: Db) {
  return createSignInRequestActions({ db, clock: systemClock });
}

// Approve one request (needs a fresh "confirm it's you"; the approver gets no session).
async function approveSignInRequestAction(id: string): Promise<SignInRequestResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  return buildActions(db).approve(session, typeof id === "string" ? id : "");
}

// Deny one request: it is discarded and the new device can't collect it.
async function denySignInRequestAction(id: string): Promise<SignInRequestResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  return buildActions(db).deny(session, typeof id === "string" ? id : "");
}

export default async function SignInRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Reading the request first marks the page dynamic (never prerendered at build time).
  const raw = (await searchParams).notice;
  const notice = signInRequestNotice(typeof raw === "string" ? raw : undefined);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const user = await getUserById(db, session.userId);
  if (!user) redirect("/signin");
  const actions = buildActions(db);
  const requests = actions.load(session);
  const factors = await actions.factors(session);
  const config = loadConfig();
  const wrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const timeZone = await timeZoneFor(db, user.id, await wrapper.unwrap(user.wrappedDek));
  return (
    <SignInRequestsView
      requests={requests}
      notice={notice}
      timeZone={timeZone}
      passkey={factors.passkey}
      authenticator={factors.authenticator}
      approve={approveSignInRequestAction}
      deny={denySignInRequestAction}
    />
  );
}
