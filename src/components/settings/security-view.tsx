import * as React from "react";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { CheckCircle2, KeyRound, MonitorSmartphone } from "lucide-react";

import { PageNotice } from "@/components/ui/notice";
import { UrlParamCleanup } from "@/components/ui/url-param-cleanup";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { EmptyState } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { FactorControls } from "@/components/auth/factor-controls";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { formatAccountTime, timeZoneNote } from "@/domain/display-time";
import { ButtonLink } from "@/components/ui/button-link";
import { SIGN_IN_REQUESTS_PATH } from "@/server/auth/sign-in-requests-path";
import { ADD_PASSKEY_ANCHOR, RemovePasskeyControl, SET_UP_AUTHENTICATOR_ANCHOR } from "./remove-passkey";
import { AddAuthenticator } from "./add-authenticator";
import { RemoveAuthenticatorControl } from "./remove-authenticator";
import type {
  ActionResult,
  BeginAddAuthenticatorResult,
  BeginAddPasskeyResult,
  RegenerateRecoveryResult,
  SecurityView,
  VerifyAddAuthenticatorResult,
} from "@/app/(portal)/(protected)/settings/security/actions";
import type { SecurityNotice } from "@/app/(portal)/(protected)/settings/security/notices";

// Settings › Security — the presentation view the thin page loader
// (src/app/(portal)/(protected)/settings/security/page.tsx) renders with this person's
// passkeys, sessions and authenticator status, and its server actions. Kept here, outside
// the page module (which may only export framework fields), so it can be render-tested.
// Presentation only: every change still runs through the page's step-up-gated actions.

// The presentation view: one heading band, the outcome slot, then one panel per task —
// how you sign in (passkeys, authenticator app), where you're signed in, and the changes
// you can make — each a WorkspacePanel with divider rows inside (never a card per row).
//
// A step-up refusal is shown INSIDE the "Confirm it's you" control (its explanation), so it
// clears itself once confirmed; every other outcome is the page notice. Either way the
// one-shot `?notice=` is removed from the address bar once shown.
export function SecuritySettings({
  view,
  currentSessionId,
  notice,
  timeZone,
  removePasskey,
  removeAuthenticator,
  signOutSession,
  beginAddPasskey,
  finishAddPasskey,
  regenerateRecovery,
  beginAddAuthenticator,
  verifyAddAuthenticator,
}: {
  view: SecurityView;
  currentSessionId: string;
  notice: SecurityNotice | null;
  timeZone: string;
  // The page's server actions (thin "use server" wrappers that re-derive the session).
  removePasskey: (formData: FormData) => void | Promise<void>;
  removeAuthenticator: (formData: FormData) => void | Promise<void>;
  signOutSession: (formData: FormData) => void | Promise<void>;
  beginAddPasskey: () => Promise<BeginAddPasskeyResult>;
  finishAddPasskey: (response: RegistrationResponseJSON) => Promise<ActionResult>;
  regenerateRecovery: () => Promise<RegenerateRecoveryResult>;
  beginAddAuthenticator: () => Promise<BeginAddAuthenticatorResult>;
  verifyAddAuthenticator: (code: string) => Promise<VerifyAddAuthenticatorResult>;
}) {
  const hasPasskey = view.passkeys.length > 0;
  const onlyPasskey = view.passkeys.length === 1;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Security"
        description="Manage how you sign in and where you're signed in. Changes here ask you to confirm it's you first."
      />

      {notice?.offerConfirm ? (
        <>
          <ConfirmItsYou
            passkey={hasPasskey}
            authenticator={view.authenticatorEnabled}
            explanation={notice.text}
            confirmedText="Thanks — that's confirmed. Make your change again within the next five minutes."
          />
          <UrlParamCleanup names={["notice"]} />
        </>
      ) : notice ? (
        <PageNotice tone={notice.tone === "done" ? "success" : "error"}>{notice.text}</PageNotice>
      ) : null}

      <WorkspacePanel
        title="How you sign in"
        description={
          view.authenticatorEnabled
            ? "Use a passkey, or your email and authenticator app, to sign in and to confirm it's you."
            : "Use a passkey to sign in and to confirm it's you."
        }
      >
        <ListGroup
          id="security-passkeys"
          level={3}
          title="Passkeys"
          count={view.passkeys.length}
          summary="Your fingerprint, face or device PIN."
        >
          {hasPasskey ? (
            view.passkeys.map((passkey, index) => {
              const name = `Passkey ${index + 1}`;
              const added = formatAccountTime(passkey.createdAt, timeZone);
              return (
                <li key={passkey.id} className={ROW}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium text-fg">{name}</span>
                    <span className="text-fg-muted">Added {added}</span>
                  </span>
                  <RemovePasskeyControl
                    action={removePasskey}
                    passkeyId={passkey.id}
                    name={name}
                    added={added}
                    onlyPasskey={onlyPasskey}
                    authenticatorEnabled={view.authenticatorEnabled}
                  />
                </li>
              );
            })
          ) : (
            <li className={LIST_ROW}>
              <EmptyState
                variant="inline"
                icon={KeyRound}
                heading="You don't have any passkeys yet."
                description="Add one under Make a change to sign in with your fingerprint, face or device PIN."
              />
            </li>
          )}
        </ListGroup>
        <ListGroup
          id="security-authenticator"
          level={3}
          title="Authenticator app"
          action={
            <Badge tone={view.authenticatorEnabled ? "success" : "neutral"} icon={view.authenticatorEnabled ? CheckCircle2 : undefined}>
              {view.authenticatorEnabled ? "Set up" : "Not set up"}
            </Badge>
          }
        >
          {view.authenticatorEnabled ? (
            // Sign-in audit: the app can be removed here too, behind the same danger confirmation.
            <li className={ROW}>
              <span className="min-w-0 flex-1 text-fg-muted">
                You can sign in with your email and a code from your authenticator app, and use a code to confirm it&apos;s you.
              </span>
              <RemoveAuthenticatorControl action={removeAuthenticator} hasPasskey={hasPasskey} />
            </li>
          ) : (
            <li className={LIST_ROW}>
              {/* Follow-up S1: set one up here (step-up gated), instead of the old sign-up-only dead end. */}
              <div id={SET_UP_AUTHENTICATOR_ANCHOR} className="min-w-0 scroll-mt-24">
                <AddAuthenticator begin={beginAddAuthenticator} verify={verifyAddAuthenticator} passkey={hasPasskey} />
              </div>
            </li>
          )}
        </ListGroup>
      </WorkspacePanel>

      <WorkspacePanel
        title="Where you're signed in"
        description={`Your active sessions and recent sign-ins. Sign out of any you don't recognise. ${timeZoneNote(timeZone)}`}
      >
        <ul role="list" className="flex min-w-0 flex-col">
          {view.sessions.map((session) => {
            const isCurrent = session.id === currentSessionId;
            const signedIn = formatAccountTime(session.createdAt, timeZone);
            const lastActive = formatAccountTime(session.lastSeenAt, timeZone);
            return (
              <li key={session.id} className={`${ROW} first:pt-0 last:pb-0`}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium text-fg">{isCurrent ? "This device" : `Signed in ${signedIn}`}</span>
                  <span className="text-fg-muted">
                    {isCurrent ? `Signed in ${signedIn} · last active ${lastActive}` : `Last active ${lastActive}`}
                  </span>
                </span>
                {isCurrent ? null : (
                  <ActionForm action={signOutSession} className="shrink-0">
                    <input type="hidden" name="sessionId" value={session.id} />
                    <FormSubmit
                      variant="secondary"
                      size="sm"
                      pendingLabel="Signing out…"
                      aria-label={`Sign out the device signed in ${signedIn}`}
                    >
                      Sign out
                    </FormSubmit>
                  </ActionForm>
                )}
              </li>
            );
          })}
        </ul>
        {/* Follow-up S3: approving a new device happens here, in the signed-in app. */}
        <div className="mt-4 flex min-w-0 flex-col gap-3 border-t border-line pt-4 text-sm sm:flex-row sm:items-center sm:justify-between [overflow-wrap:anywhere]">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2 font-medium text-fg">
              Sign-in requests
              {view.pendingSignInRequests > 0 ? (
                <Badge tone="warning">{`${view.pendingSignInRequests} waiting`}</Badge>
              ) : null}
            </span>
            <span className="text-fg-muted">Approve a new device that&apos;s asking to sign in to your account.</span>
          </span>
          <ButtonLink href={SIGN_IN_REQUESTS_PATH} size="sm" className="shrink-0">
            <MonitorSmartphone aria-hidden={true} className="h-4 w-4 shrink-0" />
            Review sign-in requests
          </ButtonLink>
        </div>
      </WorkspacePanel>

      <WorkspacePanel
        title="Make a change"
        description="Add a passkey or create a new recovery code. We'll ask you to confirm it's you first."
        footer="Your recovery code gets you back into your account if you lose your passkeys. It's different from your vault recovery phrase, which unlocks your cards and protected details."
      >
        <div id={ADD_PASSKEY_ANCHOR} className="min-w-0 scroll-mt-24">
          <FactorControls
            beginAddPasskey={beginAddPasskey}
            finishAddPasskey={finishAddPasskey}
            regenerateRecovery={regenerateRecovery}
          />
        </div>
      </WorkspacePanel>
    </div>
  );
}

// A divider row inside a panel: the item on the left, its one control on the right; the
// text wraps beside the control rather than pushing it onto a line of its own.
const ROW =
  "flex min-w-0 items-center justify-between gap-4 border-b border-line py-3 text-sm last:border-0 [overflow-wrap:anywhere]";

// The protected loader: resolve the session (sign-in if none), load this person's
// factors and sessions, and render the view (the group layout supplies the app shell).
