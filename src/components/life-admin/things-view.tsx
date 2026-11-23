"use client";

import * as React from "react";
import {
  AlertTriangle,
  Briefcase,
  Car,
  CalendarCheck,
  CalendarClock,
  ClipboardCheck,
  HeartPulse,
  House,
  IdCard,
  MailSearch,
  PawPrint,
  PiggyBank,
  Receipt,
  Repeat,
  Shapes,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty";
import type { CategoryDef, CategoryId, RecordTypeDef } from "@/domain/life-admin/record-types";
import { comingUp, organiseByCategory, type CategorySection } from "./record-groups";
import {
  dueText,
  foundInSentence,
  formatCalendarDate,
  pendingChangeLines,
  recordName,
  recordTypeOf,
  typedDueLine,
  whenText,
} from "./record-format";
import { AddRecordPanel, DisabledControl, parentOptions } from "./record-forms";
import { EditControl, NotCheckedTag, RecordFacts, RecordRow, recordProvenance } from "./record-row";
import type { AssetOption, LifeAdminAction, LifeAdminRecordView, RecordActions } from "./record-view-types";

// "Your things" (docs/adr/life-admin-profile.md): the person's life admin as a typed profile,
// filled in mostly by their own agents from email and checked by the person. Top to bottom:
//
//   1. To check — only when there is something to check: agents' suggestions (Confirm, Not
//      mine, Edit) and their proposed changes to confirmed records (Accept change, Keep mine).
//      Agents are told a suggestion isn't checked until the person confirms it, and an agent
//      never overwrites a confirmed record: its change waits here.
//   2. Coming up — what is overdue or due in the next 60 days, soonest first, each line a
//      link to its record.
//   3. One panel per category that has records, in the catalogue's order; a vehicle, home or
//      pet heads the records that belong to it.
//   4. Fill in the rest — the empty categories, and a prompt to copy into an agent.
//   5. Add something yourself — pick a type, then fill in its form.

const CATEGORY_ICONS: Readonly<Record<CategoryId, LucideIcon>> = {
  vehicle: Car,
  home: House,
  utility: Zap,
  insurance: ShieldCheck,
  health: HeartPulse,
  money: PiggyBank,
  id: IdCard,
  work: Briefcase,
  subscription: Repeat,
  pet: PawPrint,
  purchase: Receipt,
  general: Shapes,
};

type Typed = { record: LifeAdminRecordView; type: RecordTypeDef; name: string; titleKey: string | null };

function typed(record: LifeAdminRecordView): Typed {
  const type = recordTypeOf(record);
  const { name, key } = recordName(record.kind, record.type, record.fields);
  return { record, type, name, titleKey: key };
}

// A small form whose one button posts this record's id to `action`.
function RecordButton({
  action,
  recordId,
  variant,
  pendingLabel,
  children,
}: {
  action: LifeAdminAction;
  recordId: string;
  variant: "primary" | "secondary";
  pendingLabel: string;
  children: React.ReactNode;
}) {
  return (
    <ActionForm action={action}>
      <input type="hidden" name="recordId" value={recordId} />
      <FormSubmit variant={variant} size="sm" pendingLabel={pendingLabel}>
        {children}
      </FormSubmit>
    </ActionForm>
  );
}

// ─── 1. To check ─────────────────────────────────────────────────────────────────────

function SuggestionItem({ item, assets, actions }: { item: Typed; assets: readonly AssetOption[]; actions: RecordActions }) {
  const { record, type, name, titleKey } = item;
  return (
    <li id={`check-${record.id}`} className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">
            {name.startsWith(type.label) ? name : <><span className="text-fg-muted">{type.label}:</span> {name}</>}
          </p>
          <p className="text-sm text-fg-muted">{typedDueLine(type, record.dueDate, record.status)}</p>
        </div>
        <RecordFacts record={record} type={type} titleKey={titleKey} limit={4} />
        <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{recordProvenance(record)}</p>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {actions.confirmRecordAction ? (
            <RecordButton action={actions.confirmRecordAction} recordId={record.id} variant="primary" pendingLabel="Confirming…">
              Confirm<span className="sr-only"> {name}</span>
            </RecordButton>
          ) : (
            <DisabledControl label="Confirm" reason="Confirming isn't available just now." />
          )}
          {actions.dismissRecordAction ? (
            <RecordButton action={actions.dismissRecordAction} recordId={record.id} variant="secondary" pendingLabel="Removing…">
              Not mine<span className="sr-only">: {name}</span>
            </RecordButton>
          ) : null}
          <EditControl
            record={record}
            type={type}
            name={name}
            parents={parentOptions(type, assets, record.id)}
            editRecordAction={actions.editRecordAction}
            submitLabel="Save and confirm"
          />
        </div>
      </div>
    </li>
  );
}

function PendingItem({ item, actions }: { item: Typed; actions: RecordActions }) {
  const { record, type, name } = item;
  const pending = record.pending!;
  const lines = pendingChangeLines(type, record, pending);
  return (
    <li id={`change-${record.id}`} className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{pending.byName} suggests a change</p>
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
            {name.startsWith(type.label) ? null : `${type.label} · `}<a href={`#record-${record.id}`} className="font-medium text-fg underline underline-offset-4">{name}</a>
          </p>
        </div>
        {lines.length ? (
          <ul role="list" aria-label="Suggested changes" className="flex min-w-0 flex-col gap-1 text-sm">
            {lines.map((line) => (
              <li key={line.key} className="min-w-0 [overflow-wrap:anywhere]">
                <span className="text-fg-muted">{line.label}:</span>{" "}
                <span className={line.from === null ? "text-fg-muted" : "text-fg"}>{line.from ?? "not set"}</span>{" "}
                <span aria-hidden={true}>→</span>
                <span className="sr-only">changes to</span>{" "}
                <span className={line.to === null ? "text-fg-muted" : "font-medium text-fg"}>{line.to ?? "removed"}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {pending.foundIn ? <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{foundInSentence(pending.byName, pending.foundIn)}</p> : null}
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {actions.acceptPendingAction ? (
            <RecordButton action={actions.acceptPendingAction} recordId={record.id} variant="primary" pendingLabel="Accepting…">
              Accept change<span className="sr-only"> to {name}</span>
            </RecordButton>
          ) : (
            <DisabledControl label="Accept change" reason="Accepting changes isn't available just now." />
          )}
          {actions.declinePendingAction ? (
            <RecordButton action={actions.declinePendingAction} recordId={record.id} variant="secondary" pendingLabel="Keeping yours…">
              Keep mine<span className="sr-only">: {name}</span>
            </RecordButton>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ToCheckPanel({
  suggestions,
  changes,
  assets,
  actions,
}: {
  suggestions: readonly Typed[];
  changes: readonly Typed[];
  assets: readonly AssetOption[];
  actions: RecordActions;
}) {
  const confirmAll =
    suggestions.length >= 2 && actions.confirmAllAction ? (
      <ActionForm action={actions.confirmAllAction}>
        {suggestions.map((item) => (
          <input key={item.record.id} type="hidden" name="recordId" value={item.record.id} />
        ))}
        <FormSubmit variant="secondary" pendingLabel="Confirming…">
          Confirm all {suggestions.length}
        </FormSubmit>
      </ActionForm>
    ) : undefined;
  return (
    <WorkspacePanel
      title="To check"
      description="Your agents found these. Agents are told they aren't checked yet until you confirm them, and an agent never changes what you've confirmed without asking you here."
      icon={ClipboardCheck}
      footer={confirmAll}
    >
      {suggestions.length ? (
        <ListGroup id="to-check-suggestions" level={3} title="Found by your agents" count={suggestions.length}>
          {suggestions.map((item) => (
            <SuggestionItem key={item.record.id} item={item} assets={assets} actions={actions} />
          ))}
        </ListGroup>
      ) : null}
      {changes.length ? (
        <ListGroup id="to-check-changes" level={3} title="Suggested changes" count={changes.length}>
          {changes.map((item) => (
            <PendingItem key={item.record.id} item={item} actions={actions} />
          ))}
        </ListGroup>
      ) : null}
    </WorkspacePanel>
  );
}

// ─── 2. Coming up ────────────────────────────────────────────────────────────────────

function ComingUpPanel({ records, today }: { records: readonly LifeAdminRecordView[]; today: string }) {
  const items = comingUp(records, today);
  return (
    <WorkspacePanel title="Coming up" description="Anything overdue, and what's due in the next 60 days." icon={CalendarClock}>
      {items.length === 0 ? (
        <EmptyState variant="inline" icon={CalendarCheck} heading="Nothing due in the next 60 days." />
      ) : (
        <ul role="list" className="flex min-w-0 flex-col">
          {items.map(({ record, type, overdue }) => {
            const { name } = recordName(record.kind, record.type, record.fields);
            const due = record.dueDate!.slice(0, 10);
            const Icon = overdue ? AlertTriangle : CalendarClock;
            return (
              <li key={record.id} className={`${LIST_ROW} flex-row items-start gap-3`}>
                <Icon aria-hidden={true} className={`mt-3 h-4 w-4 shrink-0 ${overdue ? "text-warning" : "text-fg-muted"}`} />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <a
                    href={`#record-${record.id}`}
                    className="inline-flex min-h-11 min-w-0 items-center text-sm text-fg underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                  >
                    <span className="min-w-0">
                      {name.startsWith(type.label) ? null : <span className="text-fg-muted">{type.label} · </span>}
                      <span className="font-medium">{name}</span>
                      {" — "}
                      {overdue ? `Overdue since ${formatCalendarDate(due)}` : `${dueText(type, due)} · ${whenText(today, due)}`}
                    </span>
                  </a>
                  {record.reviewState === "suggested" ? <NotCheckedTag /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </WorkspacePanel>
  );
}

// ─── 3. One panel per category ───────────────────────────────────────────────────────

function CategoryPanel({
  section,
  assets,
  actions,
}: {
  section: CategorySection<LifeAdminRecordView>;
  assets: readonly AssetOption[];
  actions: RecordActions;
}) {
  const { category } = section;
  const row = (record: LifeAdminRecordView, lead?: string) => (
    <RecordRow key={record.id} record={record} type={recordTypeOf(record)} lead={lead} assets={assets} actions={actions} />
  );
  const assetNoun = section.assets[0]?.type.label.toLowerCase();
  return (
    <WorkspacePanel title={category.label} description={category.description} icon={CATEGORY_ICONS[category.id]}>
      {section.assets.map(({ asset, type, children }) => {
        const { name } = recordName(asset.kind, asset.type, asset.fields);
        return (
          <ListGroup
            key={asset.id}
            id={`asset-${asset.id}`}
            level={3}
            title={name}
            summary={children.length ? `${type.label} and what belongs to it` : type.label}
          >
            {row(asset, `${type.label} details`)}
            {children.map((child) => row(child))}
          </ListGroup>
        );
      })}
      {section.loose.length === 0 ? null : section.assets.length ? (
        <ListGroup id={`category-${category.id}-unlinked`} level={3} title={`Not linked to a ${assetNoun}`} count={section.loose.length}>
          {section.loose.map((record) => row(record))}
        </ListGroup>
      ) : (
        <ul role="list" className="flex min-w-0 flex-col">
          {section.loose.map((record) => row(record))}
        </ul>
      )}
    </WorkspacePanel>
  );
}

// ─── 4. Fill in the rest ─────────────────────────────────────────────────────────────

// How each empty category reads in the prompt. "Other" has nothing specific to look for.
const PROMPT_WORDS: Readonly<Record<CategoryId, string | null>> = {
  vehicle: "vehicles",
  home: "home",
  utility: "bills",
  insurance: "insurance",
  health: "health insurance",
  money: "super",
  id: "ID expiry dates",
  work: "work",
  subscription: "subscriptions",
  pet: "pets",
  purchase: "receipts",
  general: null,
};

function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The prompt the person can paste into their agent, naming what is still empty. */
export function fillInPrompt(empty: readonly CategoryDef[]): string {
  const words = empty.map((category) => PROMPT_WORDS[category.id]).filter((word): word is string => Boolean(word));
  return `Use Warthog to look through my email for my ${joinWords(words)}, and save what you find to my Life admin for me to check.`;
}

function FillInPanel({ empty, hasRecords }: { empty: readonly CategoryDef[]; hasRecords: boolean }) {
  const prompt = fillInPrompt(empty);
  return (
    <WorkspacePanel
      title={hasRecords ? "Fill in the rest" : "Fill in your life admin"}
      description="Your agent can find these in your email. What it saves waits under To check until you confirm it."
      icon={MailSearch}
      footer="Warthog doesn't read your email itself. Your agent does, through Warthog, and only what you allow it to."
    >
      <div className="flex min-w-0 flex-col gap-4">
        <ul role="list" aria-label="Nothing here yet" className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {empty.map((category) => {
            const Icon = CATEGORY_ICONS[category.id];
            return (
              <li key={category.id} className="flex min-w-0 items-start gap-2">
                <Icon aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{category.label}</p>
                  <p className="text-sm text-fg-muted">{category.description}</p>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex min-w-0 flex-col gap-3 rounded-card bg-surface-muted p-4 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-fg">Ask your agent</p>
            <p className="mt-1 text-sm text-fg [overflow-wrap:anywhere]">{prompt}</p>
          </div>
          <CopyButton value={prompt} label="prompt for your agent" />
        </div>
      </div>
    </WorkspacePanel>
  );
}

// ─── the "Your things" tab ───────────────────────────────────────────────────────────

export function ThingsView({
  records,
  today,
  addType,
  actions,
}: {
  records: readonly LifeAdminRecordView[];
  today: string;
  addType?: string | null;
  actions: RecordActions;
}) {
  const all = records.map(typed);
  const assets: AssetOption[] = all
    .filter((item) => item.type.asset)
    .map((item) => ({ id: item.record.id, name: item.name, typeId: item.type.id, typeLabel: item.type.label }));
  const suggestions = all.filter((item) => item.record.reviewState === "suggested");
  const changes = all.filter((item) => item.record.pending && item.record.reviewState !== "suggested");
  const { sections, empty } = organiseByCategory(records);
  const fillIn = empty.filter((category) => PROMPT_WORDS[category.id] !== null);
  return (
    <>
      {suggestions.length || changes.length ? (
        <ToCheckPanel suggestions={suggestions} changes={changes} assets={assets} actions={actions} />
      ) : null}
      {records.length ? <ComingUpPanel records={records} today={today} /> : null}
      {sections.map((section) => (
        <CategoryPanel key={section.category.id} section={section} assets={assets} actions={actions} />
      ))}
      {fillIn.length ? <FillInPanel empty={fillIn} hasRecords={records.length > 0} /> : null}
      <AddRecordPanel addType={addType} assets={assets} addRecordAction={actions.addRecordAction} />
    </>
  );
}
