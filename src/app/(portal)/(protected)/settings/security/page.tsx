import { notificationSenders } from "../../../../../server/notify/production";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { Notice as InlineNotice } from "@/components/ui/notice";

import { Button } from "@/components/ui/button";
import { FactorControls } from "@/components/auth/factor-controls";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";

import { loadConfig } from "../../../../../server/config";
import { getServerDb } from "../../../../../server/db/server";
import { selectSenders } from "../../../../../server/notify/senders";
import { verifySession, type Session } from "../../../../../server/auth/session";
import { systemClock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import {
  createSecurityActions,
  type SecurityView,
  type ActionResult,
  type BeginAddPasskeyResult,
  type RegenerateRecoveryResult,
} from "./actions";
import { noticeLocation, securityNotice, type SecurityNotice } from "./notices";
import type { Db } from "../../../../../server/db/index";
import type { Metadata } from "next";
import { formatAccountTime } from "@/server/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";
import { getUserById } from "@/server/db/users";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";

// The page title (review fix G8, WCAG 2.4.2): "%s · Warthog" via the root template.
export const metadata: Metadata = { title: "Security" };

// The shape of a WebAuthn attestation the client factor component posts back to
// finishAddPasskey. Validated at this server-action boundary so a malformed body is
// refused in plain words rather than reaching the verifier as a crash (INV-102); the
// real verifier still rejects anything that does not cryptographically verify. Mirrors
// the sign-up handler's registration schema (OBS: one shape, both boundaries).
const registrationResponseSchema = z.looseObject({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
  }),
  clientExtensionResults: z.looseObject({}).optional(),
});

// E04-S15 — Security settings screen (loader + view + server-action wrappers).
//
// The thin protected-page loader reads the signed-in session from the host-locked
// `__Host-wh_session` cookie, lists this person's passkeys and sessions (each
// session being also a recent sign-in) through the tested `createSecurityActions`
// seam, and renders the presentation view below. Config is read inside the handler
// (`loadConfig()`), never at module load (next build evaluates route modules with
// no runtime config), and the database comes from the process-wide `getServerDb()`
// — never `createDb` (one migrated database per process).
//
// Sensitive changes (add / remove a passkey, sign out a session, regenerate the
// recovery code) require a fresh step-up; the server-action wrappers below enforce
// that through the same seam, and every outcome comes back as a plain-words notice.
// The step-up confirmation, the WebAuthn add-passkey ceremony and the one-time
// display of a regenerated recovery code need the client factor component; until it
// lands those two controls render disabled with the reason.

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it
// is needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the security actions with the real seams, taking the RP ID from config.
function buildActions(db: Db) {
  return createSecurityActions({
    db,
    clock: systemClock,
    random: systemRandom,
    rpId: loadConfig().webauthnRpId,
    origin: new URL(loadConfig().publicBaseUrl).origin,
    alerts: { emailSender: notificationSenders(loadConfig(), db).email },
  });
}

// Remove one of this person's passkeys. A thin server-action wrapper over the
// factory: it re-derives the verified session (never trusting a client value),
// scopes the removal to that person, and redirects back with a notice naming the
// outcome — a refusal (e.g. no fresh confirmation) or a malformed id is shown in
// plain words, never swallowed (the screen must not fail silently).
async function removePasskeyAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: unknown;
  try {
    outcome = await buildActions(db).removePasskey(session, String(formData.get("passkeyId") ?? ""));
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/settings/security");
  redirect(noticeLocation("passkey_removed", outcome));
}

// Sign out another of this person's sessions. Same discipline as above.
async function signOutSessionAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: unknown;
  try {
    outcome = await buildActions(db).signOutSession(session, String(formData.get("sessionId") ?? ""));
  } catch (error) {
    outcome = error;
  }
  revalidatePath("/settings/security");
  redirect(noticeLocation("session_signed_out", outcome));
}

// Begin adding a passkey from this screen (a sensitive change). A thin server-action
// wrapper over the factory handed to the client factor component as a prop: it
// re-derives the verified session (never trusting a client value) and returns the
// registration options the client drives the ceremony with — or a refusal (e.g. no
// fresh confirmation) the client turns into plain words.
async function beginAddPasskeyAction(): Promise<BeginAddPasskeyResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  return buildActions(db).beginAddPasskey(session);
}

// Finish adding a passkey. Validate the posted attestation's shape at the boundary first
// (a malformed body is refused in plain words, never a crash; INV-102), re-derive the
// session, then verify + store the credential for this person through the factory.
async function finishAddPasskeyAction(response: RegistrationResponseJSON): Promise<ActionResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const parsed = registrationResponseSchema.safeParse(response);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_request" };
  }
  return buildActions(db).finishAddPasskey(session, parsed.data as RegistrationResponseJSON);
}

// Regenerate this person's recovery code (a sensitive change): re-derive the session and
// return the fresh code once — the client shows it a single time and never stores it.
async function regenerateRecoveryAction(): Promise<RegenerateRecoveryResult> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  return buildActions(db).regenerateRecovery(session);
}

// The outcome of the last change, in words plus an icon (never colour alone). A
// problem is announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: SecurityNotice }) {
  return (
    <InlineNotice tone={notice.tone === "done" ? "success" : "error"}>{notice.text}</InlineNotice>
  );
}

// One titled card section on the screen.
function Section({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        <p className="text-sm text-fg-muted">{lead}</p>
      </div>
      {children}
    </section>
  );
}

// The presentation view: this person's passkeys, their active sessions (each also a
// recent sign-in) and their recovery code, with the management controls.
function SecuritySettings({
  view,
  currentSessionId,
  notice,
  timeZone,
}: {
  view: SecurityView;
  currentSessionId: string;
  notice: SecurityNotice | null;
  timeZone: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Security</h1>
        <p className="text-sm text-fg-muted">
          Manage how you sign in and where you&apos;re signed in. Sensitive changes ask you to
          confirm it&apos;s you first.
        </p>
      </div>

      {notice ? <NoticeBanner notice={notice} /> : null}
      {notice?.offerConfirm ? (
        <ConfirmItsYou confirmedText="Thanks — that's confirmed. Make your change again within the next five minutes." />
      ) : null}

      <Section title="Authenticator app" lead="Use a code from your Authenticator app after checking your email.">
        <p className="text-sm text-fg">
          {view.authenticatorEnabled ? "Your Authenticator app is set up." : "You haven’t set up an Authenticator app."}
        </p>
      </Section>

      <Section title="Passkeys" lead="Sign in with your fingerprint, face or device PIN.">
        {view.passkeys.length === 0 ? (
          <p className="text-sm text-fg-muted">You don&apos;t have any passkeys yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface-muted px-3 py-2"
              >
                <span className="text-sm text-fg">Added {formatAccountTime(passkey.createdAt, timeZone)}</span>
                <form action={removePasskeyAction}>
                  <input type="hidden" name="passkeyId" value={passkey.id} />
                  <Button type="submit" variant="secondary">
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Where you're signed in"
        lead="Your active sessions and recent sign-ins. Sign out any you don't recognise."
      >
        <ul className="flex flex-col gap-2">
          {view.sessions.map((session) => {
            const isCurrent = session.id === currentSessionId;
            return (
              <li
                key={session.id}
                className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface-muted px-3 py-2"
              >
                <span className="flex flex-col text-sm text-fg">
                  <span>
                    {isCurrent ? "This device" : "Signed in"} · last active{" "}
                    {formatAccountTime(session.lastSeenAt, timeZone)}
                  </span>
                  <span className="text-fg-muted">Signed in {formatAccountTime(session.createdAt, timeZone)}</span>
                </span>
                {isCurrent ? (
                  <span className="text-sm font-medium text-fg-muted">This device</span>
                ) : (
                  <form action={signOutSessionAction}>
                    <input type="hidden" name="sessionId" value={session.id} />
                    <Button type="submit" variant="secondary">
                      Sign out
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="Make a change"
        lead="Add a passkey or create a new recovery code. We'll ask you to confirm it's you first."
      >
        <FactorControls
          beginAddPasskey={beginAddPasskeyAction}
          finishAddPasskey={finishAddPasskeyAction}
          regenerateRecovery={regenerateRecoveryAction}
        />
      </Section>
    </div>
  );
}

// The protected loader: resolve the session (sign-in if none), load this person's
// factors and sessions, and render the view (the group layout supplies the app shell).
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const raw = (await searchParams).notice;
  const notice = securityNotice(typeof raw === "string" ? raw : undefined);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const view = await buildActions(db).load(session);
  const user = await getUserById(db, session.userId);
  if (!user) redirect("/signin");
  const config = loadConfig();
  const wrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const timeZone = await timeZoneFor(db, user.id, await wrapper.unwrap(user.wrappedDek));
  // The (portal)/(protected) layout already wraps every page in the app shell (PortalChrome);
  // wrapping again here rendered two sidebars and two <main> landmarks.
  return <SecuritySettings view={view} currentSessionId={session.id} notice={notice} timeZone={timeZone} />;
}
