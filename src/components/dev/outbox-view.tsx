import * as React from "react";

import { EmptyState } from "@/components/ui/empty";
import type { SentMessage } from "@/server/notify/outbox";

// E17-S08 — Dev outbox viewer (view). A plain, prop-driven, synchronously
// renderable component that lists what the process-wide dev outbox captured so a
// developer driving the primary journey over HTTP can read the push / email / SMS
// that would otherwise go to a real device — and click through any single-use
// approval or sign-in link. It reads nothing itself: the `/dev/outbox` loader
// passes it `outbox.list()`. Built on the design tokens (globals.css), never a raw
// hex colour; a read-only viewer, so no buttons and no dead controls — a message
// carrying no link renders no link control at all.

// A developer-facing label for each channel the outbox stamps a message with.
const CHANNEL_LABEL: Record<SentMessage["channel"], string> = {
  push: "Push",
  email: "Email",
  sms: "SMS",
};

export function OutboxView({ messages }: { messages: readonly SentMessage[] }) {
  if (messages.length === 0) {
    return (
      <EmptyState
        heading="Nothing captured yet"
        description="Notifications and their single-use links appear here as the journey sends them."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {messages.map((message, index) => (
        <li
          key={index}
          className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
        >
          <div className="flex items-center gap-3">
            <span className="rounded-card bg-surface-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
              {CHANNEL_LABEL[message.channel]}
            </span>
            <span className="text-sm font-medium text-fg">{message.recipient}</span>
          </div>
          <p className="text-sm text-fg">{message.body}</p>
          {message.link ? (
            <a href={message.link} className="break-all text-sm font-medium text-accent underline">
              {message.link}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
