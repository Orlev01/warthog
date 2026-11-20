import * as React from "react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectField, TextareaField } from "@/components/ui/field";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { PageNotice, type NoticeTone } from "@/components/ui/notice";
import { CONTACT_MESSAGE_MAX, CONTACT_TOPICS, CONTACT_TOPIC_LABELS } from "@/domain/contact/topics";

// "Contact us" (docs/adr/requests-for-members.md): the signed-in person writes to the operator
// from inside Warthog, and sees what they've sent and whether it's been answered. The reply
// comes by email, to the address shown. A pure, prop-driven view: the page loads the person's
// own address and messages (dates already formatted) and binds the send action. With no action
// bound, the send button is disabled rather than a live button over nothing.

export type ContactMessageItem = {
  id: string;
  topic: string;
  excerpt: string;
  sentAt: string;
  answered: boolean;
};

export type ContactViewProps = {
  email: string;
  messages: readonly ContactMessageItem[];
  notice?: { readonly tone: NoticeTone; readonly text: string } | null;
  sendAction?: (formData: FormData) => void | Promise<void>;
};

function MessageFields() {
  return (
    <>
      <SelectField id="contact-topic" name="topic" label="What's it about?" defaultValue="question" width="text">
        {CONTACT_TOPICS.map((topic) => (
          <option key={topic} value={topic}>
            {CONTACT_TOPIC_LABELS[topic]}
          </option>
        ))}
      </SelectField>
      <TextareaField
        id="contact-message"
        name="message"
        label="Your message"
        hint="Please don't include passwords or card numbers. If you do, we hide them before we keep your message."
        rows={6}
        required
        maxLength={CONTACT_MESSAGE_MAX}
      />
    </>
  );
}

export function ContactView({ email, messages, notice, sendAction }: ContactViewProps) {
  return (
    <div className="wh-page">
      <WorkspaceHeading
        eyebrow="Help"
        title="Contact us"
        description={
          <>
            Ask a question, tell us about a problem, or make a privacy request. We&apos;ll reply by email to{" "}
            <span className="font-medium text-fg [overflow-wrap:anywhere]">{email}</span>.
          </>
        }
      />
      {notice ? <PageNotice tone={notice.tone}>{notice.text}</PageNotice> : null}

      <WorkspacePanel
        title="Send us a message"
        footer={
          <p className="text-sm text-fg-muted">
            Want a service we don&apos;t have yet?{" "}
            <a href="/connectors?view=catalogue" className="font-medium text-fg underline underline-offset-4">
              Ask for it from Connectors
            </a>
            .
          </p>
        }
      >
        {sendAction ? (
          <ActionForm action={sendAction} className="flex flex-col gap-4">
            <MessageFields />
            <div>
              <FormSubmit pendingLabel="Sending…">Send message</FormSubmit>
            </div>
          </ActionForm>
        ) : (
          <div className="flex flex-col gap-4">
            <MessageFields />
            <div className="flex flex-col items-start gap-1">
              <Button type="button" disabled>
                Send message
              </Button>
              <p className="text-xs text-fg-muted">Sending messages isn&apos;t available just now.</p>
            </div>
          </div>
        )}
      </WorkspacePanel>

      {messages.length > 0 ? (
        <WorkspacePanel title="Your messages" description="What you've sent us, newest first.">
          <ul role="list" className="flex min-w-0 flex-col divide-y divide-line">
            {messages.map((message) => (
              <li key={message.id} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-40 flex-1 flex-col gap-1">
                  <span className="font-medium text-fg">{message.topic}</span>
                  <span className="text-sm text-fg-muted [overflow-wrap:anywhere]">{message.excerpt}</span>
                  <span className="text-sm text-fg-muted">Sent {message.sentAt}</span>
                </div>
                <Badge tone={message.answered ? "success" : "neutral"}>{message.answered ? "Answered" : "Sent"}</Badge>
              </li>
            ))}
          </ul>
        </WorkspacePanel>
      ) : null}
    </div>
  );
}

export default ContactView;
