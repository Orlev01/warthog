import { agentSection, AGENT_SECTIONS } from "@/domain/permissions/workspace";
import { getUserById } from "@/server/db/users";
import { getAgentById } from "@/server/db/agents";
import { agentWorkspaceData } from "@/server/agents/workspace-data";
import { timeZoneFor } from "@/server/spending/time-zone";
import { relativeDayTime } from "@/domain/display-time";
import { PageContainer } from "@/components/shell/page-container";
import { ButtonLink } from "@/components/ui/button-link";
import type { Metadata } from "next";
import { z } from "zod";
import {
  AgentWorkspaceHeader,
  AgentOverview,
  AgentResources,
} from "@/components/agents/agent-workspace";
import * as React from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { HttpError } from "@/server/http/validate";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import { loadConfig } from "@/server/config";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { notificationSenders } from "@/server/notify/production";
import { confirmFactors } from "@/server/auth/confirm-factors";
import {
  createPermissionsActions,
  type PermissionsSaveInput,
  type SaveResult,
} from "./actions";
import { PermissionsForm } from "./permissions-form";
import { createRenameActions, renameNotice, renameNoticeKey, type RenameResult } from "./rename";
import { AgentNameForm } from "@/components/agents/agent-name-form";
import { createAccessKeyActions, type ReplaceResult, type RevokeResult } from "../access-key/actions";
import { AccessKeyPanel } from "@/components/agents/access-key-panel";
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
async function savePermissions(
  agentId: string,
  input: PermissionsSaveInput,
): Promise<SaveResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  try {
    const config = loadConfig();
    const keyWrapper = selectKeyWrapper({
      nodeEnv: config.nodeEnv,
      localKek: config.devKek,
    });
    return await createPermissionsActions({
      db,
      nameOf: serviceName,
    catalogue: getProcessCatalogue(loadConfig()),
      keyWrapper,
    }).save(session, agentId, input);
  } catch (error) {
    if (error instanceof HttpError)
      return { ok: false, reason: "invalid_request" };
    throw error;
  }
}

// Replace or revoke this agent's access key, from the "Access key" panel in its Settings
// section. Thin "use server" wrappers over the tested access-key actions: re-derive the
// verified session (never a client value), act only on that person's own agent (the bound
// id is re-validated and member-scoped by the actions), and report every outcome. The new
// key goes back to the panel once, to be shown once; it is never logged. A malformed id is
// a 4xx at the actions' boundary, reported as a plain refusal.
function accessKeyActions(db: Db) {
  const config = loadConfig();
  return createAccessKeyActions({
    db,
    keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }),
    clock: systemClock,
    random: systemRandom,
    alerts: { emailSender: notificationSenders(config, db).email },
  });
}

async function replaceAccessKey(agentId: string): Promise<ReplaceResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) return { ok: false, reason: "unauthenticated" };
  try {
    const result = await accessKeyActions(db).replace(session, agentId);
    if (result.ok) revalidatePath(`/agents/${agentId}`);
    return result;
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, reason: "invalid" };
    throw error;
  }
}

async function revokeAccessKey(agentId: string): Promise<RevokeResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) return { ok: false, reason: "unauthenticated" };
  try {
    const result = await accessKeyActions(db).revoke(session, agentId);
    if (result.ok) revalidatePath(`/agents/${agentId}`);
    return result;
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, reason: "invalid" };
    throw error;
  }
}

// Rename this agent, from the "Name" panel in its Settings section
// (docs/adr/agent-names-and-providers.md). A thin "use server" wrapper over the tested rename
// actions: re-derive the verified session (never a client value), act only on that person's
// own agent, then come back to Settings with the outcome in plain words. The name shows in
// the sidebar too, so the whole layout is revalidated. A malformed id or value is a 4xx at the
// actions' boundary, reported as a plain refusal.
async function renameAgentAction(agentId: string, formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let result: RenameResult | null = null;
  try {
    const config = loadConfig();
    result = await createRenameActions({
      db,
      clock: systemClock,
      keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }),
    }).rename(session, agentId, String(formData.get("name") ?? ""));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
  }
  if (result?.ok && result.changed) revalidatePath("/", "layout");
  redirect(`/agents/${encodeURIComponent(agentId)}?section=settings&notice=${renameNoticeKey(result)}`);
}

// The tab names the agent, and the section after the Overview: "Dev console · Warthog",
// "Dev console · Activity · Warthog" (a11y-11 / content-25), so two agents or two sections
// open in tabs can be told apart. The parent Agents layout sets a plain title, which stops
// the root "%s · Warthog" template reaching here, so the suffix is written out. An agent
// that isn't this person's (or an unknown section) is the not-found page's title.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { id } = await params;
  const section = agentSection((await searchParams).section);
  const notFoundTitle: Metadata = { title: { absolute: "Page not found · Warthog" } };
  if (!section || !z.uuid().safeParse(id).success) return notFoundTitle;
  const db = await getServerDb();
  const session = await resolveSession(db);
  const agent = session ? await getAgentById(db, session.userId, id) : null;
  if (!agent) return notFoundTitle;
  const label = AGENT_SECTIONS.find(([key]) => key === section)?.[1];
  return {
    title: {
      absolute: section === "overview" || !label
        ? `${agent.displayName} · Warthog`
        : `${agent.displayName} · ${label} · Warthog`,
    },
  };
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const section = agentSection(search.section);
  if (!section) notFound();

  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  // The KeyWrapper (local AES outside production, Key Vault in production) unwraps the
  // person's DEK so the agent's own rules, whose conditions are encrypted, can be listed.
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({
    nodeEnv: config.nodeEnv,
    localKek: config.devKek,
  });
  const props = await createPermissionsActions({
    db,
    nameOf: serviceName,
    catalogue: getProcessCatalogue(loadConfig()),
    keyWrapper,
  }).load(session, id, {
    memoryCursor:
      typeof search.memoryCursor === "string" ? search.memoryCursor : undefined,
    skillCursor:
      typeof search.skillCursor === "string" ? search.skillCursor : undefined,
  });
  if (props == null) {
    notFound();
  }

  const user = await getUserById(db, session.userId);
  if (!user) notFound();
  const dek = await keyWrapper.unwrap(user.wrappedDek);
  const data = await agentWorkspaceData(
    db,
    session.userId,
    id,
    dek,
    systemClock,
    section,
  );
  if (!data) notFound();
  const connected = data.agent.status === "connected";
  // Which ways the person can confirm it's you, for the Access key panel's confirmation.
  const factors = section === "settings" && data.accessKey ? await confirmFactors(db, session.userId) : null;
  // "Today, 6:17 pm" for the Overview's "Last request", in the member's own time zone.
  const lastActiveAt = data.agent.lastActiveAt != null ? new Date(data.agent.lastActiveAt) : null;
  const lastActive =
    section === "overview" && lastActiveAt && Number.isFinite(lastActiveAt.getTime())
      ? relativeDayTime(lastActiveAt.toISOString(), await timeZoneFor(db, session.userId, dek), systemClock.now())
      : null;
  // Memory and skill choices are paged; moving page drops unsaved edits, so the links say so.
  const firstPage =
    (section === "memory" && search.memoryCursor) || (section === "skills" && search.skillCursor)
      ? `?section=${section}`
      : null;
  const nextPage =
    section === "memory" && props.nextMemoryCursor
      ? `?section=memory&memoryCursor=${encodeURIComponent(props.nextMemoryCursor)}`
      : section === "skills" && props.nextSkillCursor
        ? `?section=skills&skillCursor=${encodeURIComponent(props.nextSkillCursor)}`
        : null;
  return (
    <PageContainer className="[overflow-wrap:anywhere]">
      <AgentWorkspaceHeader data={data} section={section} />
      {section === "overview" ? (
        <AgentOverview data={data} permissions={props} lastActive={lastActive} />
      ) : (
        <>
          <AgentResources data={data} section={section} />
          {section === "settings" ? (
            // Naming is labelling only, so it stays open for a disconnected agent too.
            <AgentNameForm
              agentName={data.agent.displayName}
              renameAction={renameAgentAction.bind(null, id)}
              notice={renameNotice(search.notice)}
            />
          ) : null}
          {section !== "activity" ? (
            // A disconnected agent's settings stay visible but can't be changed: the
            // controls are disabled and the Save bar explains why (interaction-08).
            <fieldset disabled={!connected} className="min-w-0">
              <PermissionsForm
                key={`${section}:${String(search.memoryCursor ?? search.skillCursor ?? "")}`}
                initial={{ ...props, section, embedded: true, readOnly: !connected }}
                save={savePermissions.bind(null, id)}
              />
            </fieldset>
          ) : null}
          {section === "settings" && data.accessKey ? (
            // Only an agent connected with a Warthog access key (never an OAuth one), and
            // only while it is connected: a disconnect already revoked its key.
            <AccessKeyPanel
              agentName={data.agent.displayName}
              state={data.accessKey}
              replace={replaceAccessKey.bind(null, id)}
              revoke={revokeAccessKey.bind(null, id)}
              passkey={factors?.passkey}
              authenticator={factors?.authenticator}
            />
          ) : null}
          {firstPage || nextPage ? (
            <nav aria-label={section === "memory" ? "Memory pages" : "Skill pages"} className="wh-form-actions">
              <div className="wh-form-actions-buttons">
                {firstPage ? <ButtonLink href={firstPage} size="sm">First page</ButtonLink> : null}
                {nextPage ? <ButtonLink href={nextPage} size="sm">Next page</ButtonLink> : null}
              </div>
              <p>Save your changes before moving to another page.</p>
            </nav>
          ) : null}
        </>
      )}
    </PageContainer>
  );
}
