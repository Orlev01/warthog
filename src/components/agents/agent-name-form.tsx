"use client";

import * as React from "react";
import { PenLine } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Field } from "@/components/ui/field";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { Notice, type NoticeTone } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useUnsavedChanges } from "@/components/ui/unsaved-changes";
import { AGENT_NAME_MAX } from "@/domain/agents/agent-name";

// The "Name" panel in an agent's Settings section (docs/adr/agent-names-and-providers.md). The
// person names the agent in their own words ("Gemini CLI · research"), so several agents of one
// provider can be told apart. The page's server action saves it and comes back with a notice.
// A rename is only a label: it stays available for a disconnected agent, whose history is
// still listed under its name.

export interface AgentNameFormProps {
  readonly agentName: string;
  readonly renameAction: (formData: FormData) => void | Promise<void>;
  readonly notice?: { readonly tone: NoticeTone; readonly text: string } | null;
}

export function AgentNameForm({ agentName, renameAction, notice }: AgentNameFormProps) {
  // A typed name is lost if the person follows another tab before saving: ask first (W-03).
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const unsaved = useUnsavedChanges(containerRef);
  return (
    <div ref={containerRef}>
      <WorkspacePanel
        title="Name"
        icon={PenLine}
        description="How this agent is named everywhere in Warthog: your agent list, Inbox, Activity and its rules. It doesn’t rename it in its own app."
      >
        <ActionForm action={renameAction} aria-label="Agent name" className="flex flex-col gap-3">
          <Field
            name="name"
            label="Agent name"
            defaultValue={agentName}
            required
            maxLength={AGENT_NAME_MAX}
            width="text"
            hint="For example, “Gemini CLI · research” or “Claude Code · laptop”."
          />
          <FormSubmit variant="secondary" size="sm" pendingLabel="Saving…" className="self-start">
            Save name
          </FormSubmit>
        </ActionForm>
        {notice ? <Notice tone={notice.tone} className="mt-3">{notice.text}</Notice> : null}
      </WorkspacePanel>
      <ConfirmDialog
        open={unsaved.pending !== null}
        title={unsaved.pending?.title ?? ""}
        description={unsaved.pending?.description ?? ""}
        confirmLabel={unsaved.pending?.confirmLabel ?? ""}
        cancelLabel="Keep editing"
        onConfirm={unsaved.confirm}
        onCancel={unsaved.cancel}
      />
    </div>
  );
}
