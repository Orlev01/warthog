import * as React from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import { createPermissionsActions, type PermissionsSaveInput, type SaveResult } from "./actions";
import { PermissionsForm } from "./permissions-form";
import type { Db } from "@/server/db/index";

// E10-S08 — Per-agent permissions page (the thin loader + save server action over the
// tested `createPermissionsActions` seam, `./actions`).
//
// The entry's job is thin: resolve the signed-in session from the host-locked
// `__Host-wh_session` cookie, load THIS person's own agent and its permissions through the
// seam (member-scoped — a stranger's agent id loads nothing, so the page 404s), and mount
// PermissionsView wired to the save action. Because PermissionsView's controls are
// uncontrolled native inputs with a `type="button"` save, the wiring is the client
// `PermissionsForm` (the FactorControls pattern): the page hands it the loaded data and the
// save server action, and it drives the save on the person's edit. The database comes from
// the process-wide `getServerDb()` (one migrated database per process), never `createDb`,
// and per-request data is read BEFORE the database is touched so `next build` never
// prerenders the page.
//
// Saving goes through the SAME seam: `savePermissions` re-derives the verified session
// (never trusting a client value for identity), validates the submitted edit at the seam's
// boundary, persists it against the owning connection — so the change takes effect on the
// agent's next request — and reports the outcome (success, a refusal reason, or a boundary
// 4xx), never failing silently.

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Persist a partial edit of this agent's permissions, bound to one agent id per request.
// A thin "use server" wrapper over the factory: re-derive the verified session (never
// trusting a client value), scope the save to that person's own agent, and report the
// outcome. A malformed / oversized edit throws a 4xx `HttpError` at the seam's boundary —
// caught here and reported as a plain refusal rather than a crash; a genuine fault is
// rethrown.
async function savePermissions(agentId: string, input: PermissionsSaveInput): Promise<SaveResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  try {
    return await createPermissionsActions({ db, nameOf: serviceName }).save(session, agentId, input);
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, reason: "invalid_request" };
    throw error;
  }
}

// Name a connected service through the process-wide connector catalogue (the same index
// the connectors screen and the consent screen use), or undefined when it doesn't know it.
function serviceName(connectorId: string): string | undefined {
  return getProcessCatalogue().get(connectorId)?.name;
}

// The protected loader: read per-request data first (marking the page dynamic), resolve
// the session (sign-in if none), load this person's own agent + its permissions, and mount
// the live permissions form over them. An id that is not this person's loads nothing — a
// 404. The (protected) layout already wraps every page in the app shell (PortalChrome), so
// this entry renders only its own content column.
export default async function AgentPermissionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const props = await createPermissionsActions({ db, nameOf: serviceName }).load(session, id);
  if (props == null) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <PermissionsForm initial={props} save={savePermissions.bind(null, id)} />
    </div>
  );
}
