"use client";

import * as React from "react";
import { ClipboardCheck, FileText } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { Button } from "@/components/ui/button";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { foldUnchanged, lineDiff } from "@/domain/skills/line-diff";
import type { PackageSummary } from "@/server/db/skill-packages";
import type { SkillParts, SkillSuggestionView } from "@/server/skills/agent-skills";

// What waits for the person on the Skills page (docs/adr/agent-saved-skills.md): skills their
// agents saved, switched off until the person checks them, and changes agents suggest to skills
// they already have. Nothing here reaches an agent until the person acts on it.

type SkillAction = (formData: FormData) => void | Promise<void>;
const noAction = async (_formData: FormData): Promise<void> => {};

// A name that may start a sentence ("an agent that's no longer connected" → "An agent …").
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const dayFormat = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });

// The skill as the comparison reads it: its name and when-to-use line, then its instructions.
const asText = (parts: SkillParts) => `Name: ${parts.name}\nWhen to use it: ${parts.description}\n\n${parts.body}`;

const LINE = {
  same: { sign: " ", words: "", className: "text-fg-muted" },
  added: { sign: "+", words: "Added: ", className: "bg-success/10 text-fg" },
  removed: { sign: "−", words: "Removed: ", className: "bg-danger/10 text-fg line-through decoration-danger/60" },
} as const;

// The suggested version line by line against the skill as it is, unchanged stretches folded.
// Too long to compare: both versions in full.
export function SuggestionDiff({ current, suggested }: { current: SkillParts; suggested: SkillParts }) {
  const lines = lineDiff(asText(current), asText(suggested));
  if (!lines) {
    return (
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {[["Now", current], ["Suggested", suggested]].map(([label, parts]) => (
          <div key={label as string} className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium text-fg">{label as string}</p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-card border border-line bg-surface-muted p-3 text-sm [overflow-wrap:anywhere]">{asText(parts as SkillParts)}</pre>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div role="group" aria-label="What changes" className="max-h-[32rem] min-w-0 overflow-auto rounded-card border border-line bg-surface-muted py-2 font-mono text-sm">
      {foldUnchanged(lines).map((hunk, index) =>
        hunk.kind === "unchanged" ? (
          <p key={index} className="px-3 py-1 text-fg-muted">
            {hunk.count === 1 ? "1 unchanged line" : `${hunk.count} unchanged lines`}
          </p>
        ) : (
          hunk.lines.map((line, at) => (
            <div key={`${index}-${at}`} className={`flex gap-2 whitespace-pre-wrap px-3 [overflow-wrap:anywhere] ${LINE[line.kind].className}`}>
              <span aria-hidden={true} className="shrink-0 select-none">{LINE[line.kind].sign}</span>
              <span className="min-w-0">
                {LINE[line.kind].words ? <span className="sr-only">{LINE[line.kind].words}</span> : null}
                {line.text || " "}
              </span>
            </div>
          ))
        ),
      )}
    </div>
  );
}

export function AgentSkillsToCheck({
  drafts,
  suggestions,
  agentName,
  opening,
  onOpen,
  useSuggestionAction,
  keepSkillAction,
}: {
  drafts: readonly PackageSummary[];
  suggestions: readonly SkillSuggestionView[];
  agentName: (agentId: string | undefined) => string;
  opening: string | null;
  onOpen: (packageId: string, opener: HTMLElement) => void;
  useSuggestionAction?: SkillAction;
  keepSkillAction?: SkillAction;
}) {
  if (!drafts.length && !suggestions.length) return null;
  return (
    <WorkspacePanel
      title="Waiting for you"
      description="Skills your agents saved and changes they suggest. None of it reaches an agent until you check it."
      icon={ClipboardCheck}
    >
      {drafts.length ? (
        <ListGroup id="skills-to-check-new" level={3} title="New from your agents" count={drafts.length}>
          {drafts.map((p) => (
            <li key={p.id} className={LIST_ROW}>
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <FileText aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="font-medium text-fg [overflow-wrap:anywhere]">{p.name}</p>
                    <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                      Saved by {agentName(p.savedByAgentId)} · Off until you turn it on
                    </p>
                    <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{p.description}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    aria-busy={opening === p.id}
                    aria-disabled={Boolean(opening)}
                    onClick={(event) => onOpen(p.id, event.currentTarget)}
                  >
                    Read and check<span className="sr-only"> {p.name}</span>
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ListGroup>
      ) : null}
      {suggestions.length ? (
        <ListGroup id="skills-to-check-changes" level={3} title="Suggested changes" count={suggestions.length}>
          {suggestions.map((s) => (
            <li key={s.id} id={`suggestion-${s.id}`} className={LIST_ROW}>
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="font-medium text-fg [overflow-wrap:anywhere]">
                    {capital(agentName(s.agentId))} suggests changes to {s.title}
                  </p>
                  <p className="text-sm text-fg-muted">
                    {dayFormat.format(new Date(s.createdAt))} · Your agents keep getting the skill as it is until you use these changes.
                  </p>
                </div>
                <details className="min-w-0">
                  <summary className="cursor-pointer text-sm font-medium text-accent underline underline-offset-4">
                    See what changes<span className="sr-only"> in {s.title}</span>
                  </summary>
                  <div className="mt-3">
                    <SuggestionDiff current={s.current} suggested={s.suggested} />
                  </div>
                </details>
                <div className="flex flex-wrap gap-2">
                  <ActionForm action={useSuggestionAction ?? noAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <FormSubmit size="sm" pendingLabel="Using…">
                      Use these changes<span className="sr-only"> to {s.title}</span>
                    </FormSubmit>
                  </ActionForm>
                  <ActionForm action={keepSkillAction ?? noAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <FormSubmit variant="secondary" size="sm" pendingLabel="Keeping yours…">
                      Keep mine<span className="sr-only">: {s.title}</span>
                    </FormSubmit>
                  </ActionForm>
                </div>
              </div>
            </li>
          ))}
        </ListGroup>
      ) : null}
    </WorkspacePanel>
  );
}
