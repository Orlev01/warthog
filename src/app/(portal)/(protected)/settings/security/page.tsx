import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { AppShell } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";

import { loadConfig } from "../../../../../server/config";
import { getServerDb } from "../../../../../server/db/server";
import { verifySession, type Session } from "../../../../../server/auth/session";
import { systemClock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { createSecurityActions, type SecurityView } from "./actions";
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
// that through the same seam. The step-up confirmation, the WebAuthn add-passkey
// ceremony and the one-time display of a regenerated recovery code are driven by
// the shared client factor component (as signup's "Create a passkey" is here) and
// are wired when it lands; this screen lists the factors and sessions and offers
// the controls.

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
  });
}

// Remove one of this person's passkeys. A thin server-action wrapper over the
// factory: it re-derives the verified session (never trusting a client value),
// scopes the removal to that person and refreshes the screen.
async function removePasskeyAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const passkeyId = formData.get("passkeyId");
  if (typeof passkeyId === "string") {
    await buildActions(db).removePasskey(session, passkeyId);
  }
  revalidatePath("/settings/security");
}

// Sign out another of this person's sessions. Same discipline as above.
async function signOutSessionAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const sessionId = formData.get("sessionId");
  if (typeof sessionId === "string") {
    await buildActions(db).signOutSession(session, sessionId);
  }
  revalidatePath("/settings/security");
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
function SecuritySettings({ view, currentSessionId }: { view: SecurityView; currentSessionId: string }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Security</h1>
        <p className="text-sm text-fg-muted">
          Manage how you sign in and where you&apos;re signed in. Sensitive changes ask you to
          confirm it&apos;s you first.
        </p>
      </div>

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
        <Button type="button" variant="primary">
          Add a passkey
        </Button>
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
        <Button type="button" variant="secondary">
          Generate a new recovery code
        </Button>
      </Section>
    </div>
  );
}

// The protected loader: resolve the session (sign-in if none), load this person's
// factors and sessions, and render the view inside the app shell.
export default async function SecurityPage() {
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const view = await buildActions(db).load(session);
  return (
    <AppShell activeSection="settings">
      <SecuritySettings view={view} currentSessionId={session.id} />
    </AppShell>
  );
}
