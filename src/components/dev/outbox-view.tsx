import * as React from "react";
import { Inbox } from "lucide-react";

import { EmptyState } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import type { SentMessage } from "@/server/notify/outbox";
import { renderMessageEmail } from "@/server/notify/email";

// E17-S08 — Dev outbox viewer (view). A plain, prop-driven, synchronously
// renderable component that lists what the process-wide dev outbox captured so a
// developer driving the primary journey over HTTP can read the push / email / SMS
// that would otherwise go to a real device — and click through any single-use
// approval or sign-in link. It reads nothing itself: the `/dev/outbox` loader
// passes it `outbox.list()`. The messages are divider rows in one bounded list (never
// loose on the page), and a long plus-addressed recipient wraps inside its row instead of
// widening the page on a phone (mobile-22). Built on the design tokens, never a raw hex
// colour; a read-only viewer, so no buttons and no dead controls — a message carrying no
// link renders no link control at all.
//
// An email also shows its subject and a preview of the branded email exactly as a real
// sender renders it (./notify/email), in an iframe with every sandbox restriction on
// (`sandbox=""`: no scripts, no forms, no same-origin) and the HTML as its `srcdoc`.
// `logoUrl` is the hosted Warthog mark on the configured public origin.

// A developer-facing label for each channel the outbox stamps a message with.
const CHANNEL_LABEL: Record<SentMessage["channel"], string> = {
  push: "Push",
  email: "Email",
  sms: "SMS",
};

const SUMMARY_LINK =
  "inline-flex min-h-11 w-fit cursor-pointer list-none items-center rounded-field text-sm font-medium text-fg underline underline-offset-4 lg:min-h-9 [&::-webkit-details-marker]:hidden";

function EmailPreview({ subject, html }: { subject: string; html: string }) {
  return (
    <details>
      <summary className={SUMMARY_LINK}>Preview email</summary>
      <iframe
        title={`Email preview: ${subject}`}
        sandbox=""
        srcDoc={html}
        className="mt-2 h-[640px] w-full rounded-card border border-line bg-surface"
      />
    </details>
  );
}

export function OutboxView({ messages, logoUrl }: { messages: readonly SentMessage[]; logoUrl?: string }) {
  if (messages.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        heading="Nothing captured yet"
        description="Notifications and their single-use links appear here as the journey sends them."
      />
    );
  }
  return (
    <ListGroup id="dev-outbox-messages" title="Captured messages" count={messages.length} summary="Oldest first, as the journey sent them.">
      {messages.map((message, index) => {
        const email = message.channel === "email" ? renderMessageEmail(message, { logoUrl }) : null;
        return (
          <li key={index} className={LIST_ROW}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <Badge>{CHANNEL_LABEL[message.channel]}</Badge>
              <span className="min-w-0 text-sm font-medium text-fg [overflow-wrap:anywhere]">{message.recipient}</span>
            </div>
            {email ? (
              <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                Subject: <span className="font-medium text-fg">{email.subject}</span>
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm text-fg [overflow-wrap:anywhere]">{message.body}</p>
            {message.link ? (
              <a href={message.link} className="inline-flex min-h-11 items-center break-all text-sm font-medium text-accent underline lg:min-h-0">
                {message.link}
              </a>
            ) : null}
            {email ? <EmailPreview subject={email.subject} html={email.html} /> : null}
          </li>
        );
      })}
    </ListGroup>
  );
}
