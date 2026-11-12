import { getAgentDefaults } from "@/server/db/agent-defaults";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getServerDb } from "@/server/db/server";
import { verifySession } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { HttpError } from "@/server/http/validate";
import { createAccessKeyActions, type AccessKeyInput, type CreateResult } from "./actions";
import { AccessKeyFlow } from "@/components/agents/access-key-flow";
import { connectedServices } from "@/app/oauth/consent/actions";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import { loadConfig } from "@/server/config";
import { PageContainer } from "@/components/shell/page-container";

// E10-S13 — Access-key page (the thin protected-page loader that mounts the access-key flow
// over the already-tested `createAccessKeyActions` seam, `./actions`). A platform that
// cannot use the standard connector sign-in needs a per-agent access key (constitution 16);
// until now nothing mounted those actions, so a person had nowhere to create one. The
// `/agents/connect` page links here (E10-S13 AC3).
//
// This entry reads the signed-in session from the host-locked `__Host-wh_session` cookie
// and mounts <AccessKeyFlow/>, giving it a `create` server action over the tested seam. The
// flow names the agent and picks its starting set on ONE screen, creates the key and shows
// it ONCE with a Copy control; the agents list then offers revoke / replace.
//
// Thin by design (the server-composition-roots addendum): per-request data (search params,
// then the cookie) is read BEFORE `getServerDb()` so `next build` marks the page dynamic and
// never prerenders it or opens the database at build time; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed. The
// `create` server action re-resolves db/session per request (never closing over the loader's
// handles), takes the acting user id from the VERIFIED session (never the body), and reports
// every outcome in plain words rather than failing silently — a malformed/oversized input is
// a 4xx `HttpError` at the seam's boundary, caught here and returned as a refusal (AC4). The
// `(protected)` layout already guards every page in the app shell.

const SESSION_COOKIE = "__Host-wh_session";

export default async function AccessKeyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }

  // The platform the key is for — carried from the connect page's link when present (e.g.
  // `/agents/access-key?platform=Grok`), otherwise a plain default the person can accept.
  const platformParam =
    typeof params.platform === "string" && params.platform.trim().length > 0
      ? params.platform
      : "Other";
  const defaultName = platformParam === "Other" ? "My agent" : `My ${platformParam}`;

  // The live create flow's submit seam: a server action that re-verifies the session and
  // creates the access key through the tested `create` action. It re-resolves db/session per
  // request (never closing over the loader's handles), takes the owner from the verified
  // session (never the body), and reports every outcome — a refusal, or a 4xx boundary
  // rejection of malformed/oversized input — rather than failing silently.
  async function create(input: AccessKeyInput): Promise<CreateResult> {
    "use server";
    const requestToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
    const requestDb = await getServerDb();
    const requestSession = requestToken
      ? await verifySession(requestDb, requestToken, { clock: systemClock })
      : null;
    if (!requestSession) {
      return { ok: false, reason: "unauthenticated" };
    }
    try {
      const result = await createAccessKeyActions({
        db: requestDb,
        clock: systemClock,
        random: systemRandom,
      }).create(requestSession, input);
      if (result.ok) {
        // Re-run the agents list so the new agent (with its revoke / replace controls)
        // lists right after the key is issued — no manual reload.
        revalidatePath("/agents");
      }
      return result;
    } catch (error) {
      if (error instanceof HttpError) {
        return { ok: false, reason: "invalid" };
      }
      throw error;
    }
  }

  const defaults = await getAgentDefaults(db, session.userId);
  const catalogue = getProcessCatalogue(loadConfig());
  const services = await connectedServices({ db, nameOf: id => catalogue.get(id)?.name }, session.userId);
  return (
    <PageContainer className="flex flex-col gap-6">
      <AccessKeyFlow services={services} defaultTemplate={defaults.template} create={create} defaultName={defaultName} defaultPlatform={platformParam} />
    </PageContainer>
  );
}
