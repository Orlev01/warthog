"use client";

import * as React from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Compass,
  History,
  Lightbulb,
  Link2,
  ListTodo,
  MessageSquareText,
  NotebookPen,
  SearchX,
  UserCheck,
} from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { JOURNAL_TEXT_MAX } from "@/domain/life-admin/journal-text";
import { shortDate } from "@/domain/life-admin/journal";
import { listStatusOf, phaseOfView, recordsHref } from "./record-groups";
import { PhaseBadge } from "./phase-badge";
import { DisabledControl, HINT_CLASS, summaryClass } from "./record-forms";
import { RecordFacts, kindLine, recordProvenance } from "./record-row";
import type { ItemActions, JournalItemView, LifeAdminItemData } from "./record-view-types";

// An item's own page (docs/adr/life-admin-journal.md): one record — a standing item, a booking
// or a case, live or finished — with where it stands in the same one line any agent gets for
// it, its next steps (mark one done), the decisions in force (and those a later one replaced),
// notes and hand-over notes, a form to add a note, decision or next step, who is handling it
// (a label, never a lock or a permission), and Warthog's own record of what changed, by day and
// by who. Finished items keep all of it. Everything an agent or the person wrote is shown as
// text, never as a link; who wrote it is always said ("You", or the agent's name).

const itemHref = (id: string) => `/life-admin/items/${encodeURIComponent(id)}`;

function EntryRow({ entry, children }: { entry: JournalItemView; children?: React.ReactNode }) {
  return (
    <li className={LIST_ROW}>
      <p className="text-sm text-fg [overflow-wrap:anywhere]">{entry.text}</p>
      <p className="text-sm text-fg-muted">
        {entry.by} · {entry.when}
      </p>
      {children}
    </li>
  );
}

// The note / decision / next step form: one or two lines, at most 280 characters, a due date
// for a next step. The character count is shown as the person types.
function AddEntryForm({ recordId, action }: { recordId: string; action?: ItemActions["addJournalAction"] }) {
  const id = React.useId();
  const [length, setLength] = React.useState(0);
  if (!action) return <DisabledControl label="Add to the log" reason="Adding to the log isn't available just now." />;
  return (
    <ActionForm action={action} className="flex min-w-0 flex-col gap-4">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={recordId} />
        <SelectField label="What is it?" id={`${id}-kind`} name="entryKind" defaultValue="note" width="text">
          <option value="note">A note</option>
          <option value="decision">A decision, and why</option>
          <option value="next">A next step</option>
        </SelectField>
        <TextareaField
          label="What to add"
          id={`${id}-text`}
          name="text"
          required
          maxLength={JOURNAL_TEXT_MAX}
          hint={`One or two lines, up to ${JOURNAL_TEXT_MAX} characters (${length} used). Never passwords, card, bank or ID numbers.`}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setLength(event.currentTarget.value.length)}
          width="text"
        />
        <Field label="Due (optional, for a next step)" id={`${id}-due`} name="due" type="date" width="short" />
      </PendingFormFields>
      <div>
        <FormSubmit variant="primary" pendingLabel="Adding…">Add to the log</FormSubmit>
      </div>
    </ActionForm>
  );
}

function StewardForm({ data, action }: { data: LifeAdminItemData; action?: ItemActions["setStewardAction"] }) {
  const id = React.useId();
  if (!action) return <DisabledControl label="Save" reason="Changing who handles this isn't available just now." />;
  if (data.agents.length === 0 && !data.steward) {
    return (
      <EmptyState
        variant="inline"
        icon={UserCheck}
        heading="No agents connected."
        description="Connect an agent to ask it to handle this."
        action={<ButtonLink href="/agents" size="sm">Go to Agents</ButtonLink>}
      />
    );
  }
  return (
    <ActionForm action={action} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={data.record.id} />
        <SelectField label="Handled by" id={`${id}-steward`} name="agentId" defaultValue={data.steward?.agentId ?? "none"} width="text">
          <option value="none">No one</option>
          {data.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </SelectField>
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" pendingLabel="Saving…">Save</FormSubmit>
      </div>
    </ActionForm>
  );
}

export function LifeAdminItemView({
  data,
  notice,
  addJournalAction,
  markNextDoneAction,
  setStewardAction,
}: { data: LifeAdminItemData | null; notice?: React.ReactNode } & ItemActions) {
  if (!data) {
    return (
      <>
        <WorkspaceHeading eyebrow="Life admin" title="Item not found" description="It may have been removed, or the link is wrong." />
        {notice}
        <EmptyState
          icon={SearchX}
          heading="This item isn't in your Life admin."
          description="It may have been deleted or marked as not yours. Everything you keep is under Records."
          action={<ButtonLink href="/life-admin?view=life&tab=records" variant="primary">Back to Life admin</ButtonLink>}
        />
      </>
    );
  }
  const { record, type, zone } = data;
  const phase = phaseOfView(record);
  const currentYear = data.today.slice(0, 4);
  // Back to its row in Records: one that isn't active needs its status shown too.
  const status = listStatusOf(record);
  const backHref = `${recordsHref({ categories: [], statuses: status === "active" ? ["active"] : ["active", status] })}#record-${encodeURIComponent(record.id)}`;
  const historyCount = data.history.reduce((sum, day) => sum + day.groups.reduce((n, group) => n + group.lines.length, 0), 0);
  return (
    <>
      <WorkspaceHeading
        eyebrow="Life admin"
        title={data.name}
        description={`${data.kindLabel} · ${data.categoryLabel}`}
        meta={<PhaseBadge phase={phase.phase} label={phase.label} />}
      >
        <ButtonLink href={backHref} variant="secondary">
          <ArrowLeft aria-hidden={true} className="h-4 w-4 shrink-0" />
          Back to Life admin
        </ButtonLink>
      </WorkspaceHeading>
      {notice}

      <WorkspacePanel title="Where it stands" description="The same one-line summary an agent gets when it picks this up." icon={Compass}>
        <div className="flex min-w-0 flex-col gap-4">
          <p className="rounded-card bg-surface-muted p-4 text-sm text-fg [overflow-wrap:anywhere]">{data.whereItStands}</p>
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{kindLine(type, record, zone, currentYear)}</p>
          <RecordFacts record={record} type={type} titleKey={null} zone={zone} currentYear={currentYear} />
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{recordProvenance(record)}</p>
          {data.parent ? (
            <p className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted [overflow-wrap:anywhere]">
              <Link2 aria-hidden={true} className="h-4 w-4 shrink-0" />
              Part of{" "}
              <a href={itemHref(data.parent.id)} className="font-medium text-fg underline underline-offset-4">
                {data.parent.name}
              </a>{" "}
              ({data.parent.kindLabel})
            </p>
          ) : null}
        </div>
        {data.children.length ? (
          <ListGroup id="item-children" level={3} title="Belongs to it" count={data.children.length}>
            {data.children.map((child) => (
              <li key={child.id} className={LIST_ROW}>
                <a href={itemHref(child.id)} className="inline-flex min-h-11 items-center text-sm font-medium text-fg underline-offset-4 hover:underline [overflow-wrap:anywhere]">
                  {child.name}
                </a>
                <p className="text-sm text-fg-muted">{[child.kindLabel, child.phaseLabel].filter(Boolean).join(" · ")}</p>
              </li>
            ))}
          </ListGroup>
        ) : null}
      </WorkspacePanel>

      <WorkspacePanel title="Next steps" description="What's next on this, recorded by you or your agents." icon={ListTodo}>
        {data.openSteps.length === 0 ? (
          <EmptyState variant="inline" icon={CheckCircle2} heading="No open next steps." description="Add one below, so whoever picks this up next knows what to do." />
        ) : (
          <ul role="list" aria-label="Open next steps" className="flex min-w-0 flex-col">
            {data.openSteps.map((step) => (
              <EntryRow key={step.id} entry={step}>
                {step.due ? <p className="text-sm text-fg">Due {shortDate(step.due, zone)}{step.due < data.today ? " (overdue)" : ""}</p> : null}
                {markNextDoneAction ? (
                  <ActionForm action={markNextDoneAction} className="mt-1">
                    <input type="hidden" name="recordId" value={record.id} />
                    <input type="hidden" name="stepId" value={step.id} />
                    <FormSubmit variant="secondary" size="sm" pendingLabel="Marking done…">
                      Mark done<span className="sr-only">: {step.text}</span>
                    </FormSubmit>
                  </ActionForm>
                ) : null}
              </EntryRow>
            ))}
          </ul>
        )}
        {data.doneSteps.length ? (
          <ListGroup id="item-done-steps" level={3} title="Done" count={data.doneSteps.length} collapsible>
            {data.doneSteps.map((step) => (
              <EntryRow key={step.id} entry={step}>
                <p className="text-sm text-fg-muted">Done {step.doneWhen} by {step.doneBy}</p>
              </EntryRow>
            ))}
          </ListGroup>
        ) : null}
      </WorkspacePanel>

      <WorkspacePanel title="Decisions" description="What was decided and why, newest first. Agents read these before carrying on." icon={Lightbulb}>
        {data.decisions.length === 0 ? (
          <EmptyState variant="inline" icon={Lightbulb} heading="No decisions recorded yet." />
        ) : (
          <ul role="list" aria-label="Decisions in force" className="flex min-w-0 flex-col">
            {data.decisions.map((decision) => (
              <EntryRow key={decision.id} entry={decision} />
            ))}
          </ul>
        )}
        {data.replaced.length ? (
          <ListGroup id="item-replaced" level={3} title="Replaced" count={data.replaced.length} collapsible>
            {data.replaced.map((decision) => (
              <EntryRow key={decision.id} entry={decision}>
                <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">Replaced by: {decision.replacedBy}</p>
              </EntryRow>
            ))}
          </ListGroup>
        ) : null}
      </WorkspacePanel>

      <WorkspacePanel title="Notes" description="Notes and hand-over notes, newest first." icon={NotebookPen}>
        {data.notes.length === 0 && data.handovers.length === 0 ? (
          <EmptyState variant="inline" icon={NotebookPen} heading="No notes yet." />
        ) : null}
        {data.handovers.length ? (
          <ListGroup id="item-handovers" level={3} title="Hand-over notes" count={data.handovers.length}>
            {data.handovers.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ListGroup>
        ) : null}
        {data.notes.length ? (
          <ListGroup id="item-notes" level={3} title="Notes" count={data.notes.length}>
            {data.notes.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ListGroup>
        ) : null}
      </WorkspacePanel>

      <WorkspacePanel
        title="Add a note or decision"
        description="Write it for whoever picks this up next, you or any of your agents."
        icon={MessageSquareText}
      >
        <AddEntryForm recordId={record.id} action={addJournalAction} />
      </WorkspacePanel>

      <WorkspacePanel
        title="Handled by"
        description={data.steward ? `${data.steward.name} is handling this.` : "No one is handling this."}
        icon={UserCheck}
        footer="A label so you and your agents know who is carrying this on. It never changes what an agent can see or do."
      >
        <StewardForm data={data} action={setStewardAction} />
      </WorkspacePanel>

      <WorkspacePanel
        title="History"
        description={historyCount ? "What Warthog recorded as it changed, newest first." : "Nothing recorded yet."}
        icon={History}
        footer={
          <a href={`/activity?record=${encodeURIComponent(record.id)}`} className="inline-flex min-h-11 items-center text-sm font-medium text-fg underline underline-offset-4">
            See in Activity
          </a>
        }
      >
        {historyCount ? (
          <details className="group/history min-w-0">
            <summary className={summaryClass("ghost", "sm")}>
              Show history ({historyCount} {historyCount === 1 ? "change" : "changes"})
            </summary>
            <div className="mt-3 flex min-w-0 flex-col gap-4">
              {data.history.map((day) => (
                <section key={day.day} aria-label={day.day} className="flex min-w-0 flex-col gap-2 rounded-card bg-surface-muted p-4">
                  <h3 className="text-sm font-medium text-fg">{day.day}</h3>
                  {day.groups.map((group, index) => (
                    <div key={`${group.by}-${index}`} className="flex min-w-0 flex-col gap-1">
                      <p className="text-sm text-fg-muted">{group.by}</p>
                      <ul role="list" className="flex min-w-0 list-disc flex-col gap-1 ps-5 text-sm text-fg">
                        {group.lines.map((line, lineIndex) => (
                          <li key={lineIndex} className="[overflow-wrap:anywhere]">{line}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </details>
        ) : (
          <p className={HINT_CLASS}>Changes Warthog records to this item show here.</p>
        )}
      </WorkspacePanel>
    </>
  );
}
