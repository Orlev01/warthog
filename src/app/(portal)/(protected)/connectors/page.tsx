import { createProviderRuntime } from "@/server/connectors/provider-runtime";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import { createConnectorRuntime } from "@/server/connectors/runtime";
import { oauthClientFor } from "@/server/connectors/client-config";
import { notificationSenders } from "../../../../server/notify/production";
import * as React from "react";
import { join } from "node:path";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice } from "@/components/ui/notice";
import { connectorNotice } from "./notices";

import { loadConfig, type Config } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { getUserById } from "@/server/db/users";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { processSingleton } from "@/server/seams/process-singleton";
import { selectSenders, type Senders, type OutgoingMessage } from "@/server/notify/senders";
import { HttpError } from "@/server/http/validate";
import { connectCallbackUrl } from "@/server/http/routes";
import { loadCatalogue, type CatalogueIndex } from "@/server/connectors/catalogue";
import { createGuardedProviderFetch } from "@/server/connectors/provider-mcp";
import type { Db } from "@/server/db/index";
import type { OAuthClientConfig } from "@/server/connectors/oauth-client";
import { createConnectorsActions, type ConnectorsActions } from "./actions";
import { ConnectorsView } from "@/components/connectors/connectors-view";

// E09-S17 — Connectors page (the thin protected-page loader over the tested
// `createConnectorsActions` seam, `./actions`). It reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into the person's
// catalogue browse + their OWN connections, and mounts the already-render-tested
// <ConnectorsView/> with each control bound to a `use server` wrapper over the seam:
// Connect starts the right connect flow, Disconnect removes a service, Request files a
// connector request. Every wrapper re-derives the verified session (never trusting a client
// value for identity) and reports its outcome through a `?notice=` the page renders in plain
// words — never failing silently.
//
// Thin by design (the server-composition-roots addendum): per-request data (the cookie, the
// search params) is read BEFORE `getServerDb()` so `next build` marks the page dynamic and
// never prerenders it or opens the database at build time; config is read INSIDE the handler
// (`loadConfig()`), never at module load; the database comes from the process-wide
// `getServerDb()`, never `createDb`, and the shared handle is never closed; the catalogue is
// a process-wide singleton. The `(protected)` layout already wraps every page in the app
// shell. Config and secrets flow only through `loadConfig()` (INV-103) — this entry reads no
// `process.env` of its own.

const SESSION_COOKIE = "__Host-wh_session";

// The in-memory catalogue index, built once per process from the operator's data files
// (`catalogue/connectors/*.json`, rooted at the working directory — never `import.meta.url`,
// which the bundler mis-resolves). No per-connector OAuth client app is registered in config
// yet, so no oauth2 connector reports connectable until that operator registration lands.
function getCatalogue(): CatalogueIndex { return getProcessCatalogue(loadConfig()); }

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is needed
// so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Real senders stand-in: until the Azure channel senders are built, sending through one
// rejects loudly rather than dropping the message (constitution: never fail silently). With
// dev tooling on, `selectSenders` routes every channel to the dev outbox instead.


// Build the connectors actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets `dekFor` unwrap the session person's own DEK
// (the credential envelopes encrypt under it).
function buildActions(db: Db, config: Config): ConnectorsActions {
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const dekFor = async (userId: string): Promise<Uint8Array> => {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  };
  const redirectUri = connectCallbackUrl(config.publicBaseUrl);
  const runtime = createConnectorRuntime({ config, db });
  return createConnectorsActions({
    startProviderSignin: runtime.begin,
    providerMcpAvailable: true,
    startProviderMcp:runtime.begin,
    providerToolsets:createProviderRuntime({db,catalogue:getCatalogue(),clock:systemClock,publicBaseUrl:config.publicBaseUrl,dekFor}).toolsets,
    db,
    clock: systemClock,
    catalogue: getCatalogue(),
    dekFor,
    fetch: createGuardedProviderFetch(),
    email: notificationSenders(config, db).email,
    operatorEmail: config.operatorEmail ?? "",
    googleEarlyAccess: config.googleEarlyAccess,
    oauthClientConfigFor: (id) => oauthClientFor(config, id),
    providerMcpConfig: {
      clientMetadataUrl: new URL("/oauth/client-metadata.json", config.publicBaseUrl).href,
    },
    listProviderTools: async () => { throw new Error("Use the authenticated provider runtime"); },
    revokeProviderAccess: runtime.revoke,
  });
}

function formValue(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

// Connect: start the right connect flow for the chosen connector. A provider sign-in is
// started by redirecting to the provider's authorize URL; a provider-hosted MCP service is
// connected directly; an api-key / basic service needs the person's own key, collected on a
// guided entry step (a later task) the control sends them to. A malformed id (a 4xx from the
// seam) is reported as a plain problem rather than a crash; a genuine fault rethrows.
async function connectAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const connectorId = formValue(formData, "connectorId");
  const config = loadConfig();
  const actions = buildActions(db, config);
  const entry = getCatalogue().get(connectorId);
  let target = "/connectors?notice=problem";
  try {
    if (entry?.auth_kind === "oauth2") {
      const authorize = (await actions.connectProviderSignin(session, { connectorId })) as {
        url: string;
      };
      target = authorize.url;
    } else if (entry?.auth_kind === "provider_mcp") {
      const authorize = await actions.connectProviderMcp(session, { connectorId, accountLabel: entry.name }) as {url:string};
      target = authorize.url;
    } else if (entry) {
      target = `/connectors/key?connector=${encodeURIComponent(entry.id)}`;
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    target = "/connectors?notice=problem";
  }
  revalidatePath("/connectors");
  redirect(target);
}

async function reconnectAction(formData:FormData):Promise<void> {
  "use server";
  const db=await getServerDb(),session=await resolveSession(db);
  if(!session) redirect("/signin");
  const id=formValue(formData,"connectionId");
  const {getConnectionById}=await import("@/server/db/connections");
  const connection=await getConnectionById(db,session.userId,id);
  if(!connection) redirect("/connectors?notice=problem");
  let target="/connectors?notice=problem";
  try {target=(await createConnectorRuntime({config:loadConfig(),db}).begin(session,connection.connectorId,id)).url;} catch {}
  redirect(target);
}

// Disconnect one of the acting person's OWN connected services (removing every agent's access
// and revoking the stored provider access where allowed). A refusal (another person's id) or
// a malformed id is reported in plain words, never swallowed.
async function disconnectAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const connectionId = formValue(formData, "connectionId");
  const config = loadConfig();
  let notice = "disconnected";
  try {
    const result = await buildActions(db, config).disconnectService(session, connectionId);
    if (!result.ok) {
      notice = "problem";
    } else if (result.providerRevoked === false) {
      notice = "provider-revoke-needed";
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    notice = "problem";
  }
  revalidatePath("/connectors");
  redirect(`/connectors?notice=${notice}`);
}

// Request a connector not in the catalogue yet (recorded for the person, emailed to the
// operator). A malformed / oversized name (a 4xx from the seam) is reported as a problem.
async function requestAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const name = formValue(formData, "name");
  const config = loadConfig();
  let notice = "requested";
  try {
    await buildActions(db, config).requestConnector(session, { name });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    notice = "problem";
  }
  revalidatePath("/connectors");
  redirect(`/connectors?notice=${notice}`);
}

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const notice = connectorNotice(params.notice);
  const config = loadConfig();
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const data = await buildActions(db, config).load(
    session,
    query !== undefined ? { query } : undefined,
  );
  return (
    <>
      {notice ? <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6"><Notice tone={notice.tone}>{notice.text}</Notice></div> : null}
      <ConnectorsView
        initialView={typeof params.view === "string" ? params.view : undefined}
        {...data}
        connectAction={connectAction}
        disconnectAction={disconnectAction}
        reconnectAction={reconnectAction}
        requestAction={requestAction}
      />
    </>
  );
}
