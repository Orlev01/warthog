import * as React from "react";
import { MonitorSmartphone } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { PageNotice } from "@/components/ui/notice";
import { EmptyState } from "@/components/ui/empty";
import { ButtonLink } from "@/components/ui/button-link";
import { formatAccountTime, timeOfDay, timeZoneNote } from "@/domain/display-time";
import { SignInRequestDecision, type SignInRequestAnswer } from "./sign-in-request-decision";
import { APPROVE_WARNING } from "./sign-in-request-copy";
import type { SignInRequestNotice } from "@/app/(portal)/(protected)/settings/security/sign-in-requests/actions";

// Settings › Security › Sign-in requests (follow-up S3; docs/adr/security-followups-2026-11.md)
// — the presentation view the thin page loader renders with the member's OWN waiting
// "approve from another device" requests. Each row names the device (a label the server
// derives from the requesting browser, never the requester's own words), when it was asked
// and when it expires, with Approve and Deny that each ask first. The URL that brings a
// member here carries no request id: the list always comes from the session.

export interface SignInRequestItem {
  readonly id: string;
  readonly deviceLabel: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

const ROW =
  "flex min-w-0 flex-col gap-3 border-b border-line py-3 text-sm first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between [overflow-wrap:anywhere]";

export function SignInRequestsView({
  requests,
  notice,
  timeZone,
  passkey,
  authenticator,
  approve,
  deny,
}: {
  requests: readonly SignInRequestItem[];
  notice: SignInRequestNotice | null;
  timeZone: string;
  passkey: boolean;
  authenticator: boolean;
  approve: (id: string) => Promise<SignInRequestAnswer>;
  deny: (id: string) => Promise<SignInRequestAnswer>;
}) {
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Sign-in requests"
        description={`When you sign in on a new device, you can approve it from a device where you're already signed in. ${APPROVE_WARNING}`}
      >
        <ButtonLink href="/settings/security">Back to Security</ButtonLink>
      </WorkspaceHeading>

      {notice ? <PageNotice tone={notice.tone === "done" ? "success" : "error"}>{notice.text}</PageNotice> : null}

      <WorkspacePanel
        title="Waiting for you"
        description={`Requests last 10 minutes. ${timeZoneNote(timeZone)}`}
        action={<a href="/settings/security/sign-in-requests">Check again</a>}
      >
        {requests.length ? (
          <ul role="list" className="flex min-w-0 flex-col">
            {requests.map((request) => (
              <li key={request.id} className={ROW}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium text-fg">{request.deviceLabel}</span>
                  <span className="text-fg-muted">
                    Requested {formatAccountTime(request.requestedAt, timeZone)} · Expires{" "}
                    <time dateTime={request.expiresAt.toISOString()}>{timeOfDay(request.expiresAt.toISOString(), timeZone)}</time>
                  </span>
                </span>
                <SignInRequestDecision
                  id={request.id}
                  deviceLabel={request.deviceLabel}
                  approve={approve}
                  deny={deny}
                  passkey={passkey}
                  authenticator={authenticator}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            variant="inline"
            icon={MonitorSmartphone}
            heading="No sign-in requests right now."
            description="On a new device, choose “Approve from another device” on the sign-in screen and enter your email code. The request then waits here for 10 minutes."
          />
        )}
      </WorkspacePanel>
    </div>
  );
}
