import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { AppShell } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";

import { loadConfig } from "../../../../../server/config";
import { getServerDb } from "../../../../../server/db/server";
import { verifySession, type Session } from "../../../../../server/auth/session";
import { systemClock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { createSecurityActions, type SecurityView } from "./actions";
import { noticeLocation, securityNotice, type SecurityNotice } from "./notices";
import type { Db } from "../../../../../server/db/index";

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

// The outcome of the last change, in words plus an icon (never colour alone). A
// problem is announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: SecurityNotice }) {
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

// A medium date + short time in Australian English (plain, no protocol jargon).
const WHEN = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });
function formatWhen(value: Date): string {
  return WHEN.format(value);
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
}: {
  view: SecurityView;
  currentSessionId: string;
  notice: SecurityNotice | null;
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
                <span className="text-sm text-fg">Added {formatWhen(passkey.createdAt)}</span>
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
        {/* Not wired yet: the passkey ceremony needs the client factor component. Disabled with
            the reason, never a live-looking button that does nothing. */}
        <div className="flex flex-col gap-1">
          <Button type="button" variant="primary" disabled aria-describedby="add-passkey-note">
            Add a passkey
          </Button>
          <p id="add-passkey-note" className="text-sm text-fg-muted">
            Adding another passkey from this screen is coming soon.
          </p>
        </div>
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
                    {formatWhen(session.lastSeenAt)}
                  </span>
                  <span className="text-fg-muted">Signed in {formatWhen(session.createdAt)}</span>
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
        title="Recovery code"
        lead="Your way back in if you ever lose every passkey. Generating a new one replaces the old."
      >
        <div className="flex flex-col gap-1">
          <Button type="button" variant="secondary" disabled aria-describedby="new-recovery-note">
            Generate a new recovery code
          </Button>
          <p id="new-recovery-note" className="text-sm text-fg-muted">
            Generating a new recovery code from this screen is coming soon.
          </p>
        </div>
      </Section>
    </div>
  );
}

// The protected loader: resolve the session (sign-in if none), load this person's
// factors and sessions, and render the view inside the app shell.
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
  return (
    <AppShell activeSection="settings">
      <SecuritySettings view={view} currentSessionId={session.id} notice={notice} />
    </AppShell>
  );
}
