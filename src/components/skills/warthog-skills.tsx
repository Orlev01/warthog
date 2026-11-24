import * as React from "react";
import { Check, ChevronDown, Lock, Pencil, Power, PowerOff, RefreshCw, RotateCcw, Save, Trash2, Users } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Field, TextareaField } from "@/components/ui/field";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { Notice } from "@/components/ui/notice";
import type { SkillAgent } from "./agent-scope";
import { useWhenLine } from "./use-when";

// Warthog's own skills on the Skills page (docs/adr/editable-builtin-skills.md). Every one of
// them is listed, in three groups, and the person can edit each one's guidance, switch it off,
// choose which agents get it, remove it and restore Warthog's version. The fixed rules are
// shown read-only. Each skill is a native <details> and every control a plain form submit, so
// the section works before the page has hydrated (or without client JS at all).
//
// Every form posts the skill's `key` and the `change` it makes to the one server action the page
// passes, which hands it to the seam's `changeWarthogSkill`
// (src/app/(portal)/(protected)/skills/warthog-form.ts reads it).

// One of Warthog's skills as the page's loader shapes it (WarthogSkillView in the skills
// actions); declared here so this view doesn't import server modules.
export type WarthogSkillItem = {
  readonly key: string;
  readonly title: string;
  readonly group: "warthog" | "everyday" | "pack";
  // The person's wording, or Warthog's when they haven't changed it.
  readonly useThisWhen: string;
  readonly guidance: string;
  readonly warthogUseThisWhen: string;
  readonly warthogGuidance: string;
  // Fixed lines no one can change.
  readonly rules: readonly string[];
  // What Warthog generates for each agent, in words.
  readonly adds: string | null;
  // Which agents it's for, in words ("Agents that can save to your Life admin").
  readonly needs: string | null;
  readonly state: "on" | "off" | "removed";
  readonly scope: "all" | "chosen";
  readonly scopedAgentIds: readonly string[];
  readonly edited: boolean;
  readonly updateAvailable: boolean;
};

type SkillAction = (formData: FormData) => void | Promise<void>;

// The seam's limits (skills actions), so the browser stops the person before the server does.
const USE_THIS_WHEN_MAX = 500;
const GUIDANCE_MAX = 20_000;
// A value of only spaces counts as empty (the server trims before it checks too).
const NOT_BLANK = ".*\\S.*";

// A preview or render test with no action stores nothing.
const noAction = async (_formData: FormData): Promise<void> => {};

const GROUPS: ReadonlyArray<{ group: WarthogSkillItem["group"]; title: string; summary: string }> = [
  { group: "warthog", title: "How agents use Warthog", summary: "Warthog's own guides for your agents. Switched on to start." },
  { group: "everyday", title: "Everyday", summary: "Help with everyday jobs. Switched on to start." },
  { group: "pack", title: "Packs", summary: "Off until you switch one on." },
];

// Same disclosure layout as the person's own skill cards and the memory rows: where the browser
// supports it, the summary sits in the action row and the opened panel spans the width under it.
const ROW_DISCLOSURE =
  "min-w-0 open:basis-full supports-[selector(::details-content)]:contents details-content:basis-full details-content:order-last not-open:details-content:hidden";
const DISCLOSURE_PANEL = "flex min-w-0 flex-col gap-3 rounded-card bg-surface-muted p-4";
const ROW_SUMMARY = `${buttonClasses({ variant: "secondary", size: "sm" })} list-none [&::-webkit-details-marker]:hidden`;
const ICON = "h-4 w-4 shrink-0";

// The words a screen reader adds so a control names the skill it acts on.
function Named({ children }: { children: string }) {
  return <span className="sr-only">{children}</span>;
}

// "a", "a and b", "a, b and c".
function listed(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// What Restore would reset, as one sentence, or null when the skill is already as Warthog
// starts it. Restoring drops the person's changes, so it takes back their wording, the on/off
// state a skill starts with (packs start off) and All agents.
export function restoreCopy(skill: WarthogSkillItem): string | null {
  const startsOn = skill.group !== "pack";
  const offButStartsOn = skill.state === "off" && startsOn;
  if (!skill.edited && !offButStartsOn && skill.scope !== "chosen") return null;
  const parts: string[] = [];
  if (skill.edited) parts.push("puts back Warthog's wording");
  if (offButStartsOn) parts.push("switches it back on");
  if (skill.state === "on" && !startsOn) parts.push("switches it off");
  if (skill.scope === "chosen") parts.push("sets Who gets it back to All agents");
  return `Restoring ${listed(parts)}.`;
}

// "Agents that can read your calendar" → "Only for agents that can read your calendar."
function onlyFor(needs: string): string {
  return `Only for ${needs.charAt(0).toLowerCase()}${needs.slice(1)}.`;
}

// A form that posts one change to one skill.
function ChangeForm({
  skill,
  change,
  action,
  className,
  children,
}: {
  skill: WarthogSkillItem;
  change: string;
  action: SkillAction;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ActionForm action={action} className={className}>
      <input type="hidden" name="key" value={skill.key} />
      <input type="hidden" name="change" value={change} />
      {children}
    </ActionForm>
  );
}

// How the skill stands, in words (never colour alone).
function Badges({ skill }: { skill: WarthogSkillItem }) {
  return (
    <>
      {skill.state === "on" ? (
        <Badge tone="success" icon={Check}>
          On
        </Badge>
      ) : (
        <Badge icon={PowerOff}>Off</Badge>
      )}
      {skill.scope === "chosen" ? <Badge icon={Users}>Chosen agents</Badge> : null}
      {skill.edited ? <Badge icon={Pencil}>Edited</Badge> : null}
      {skill.updateAvailable ? (
        <Badge tone="info" icon={RefreshCw}>
          Warthog updated this
        </Badge>
      ) : null}
    </>
  );
}

// Warthog changed this skill after the person edited it: take the new version, keep theirs, or
// read Warthog's first.
function UpdateNotice({ skill, action }: { skill: WarthogSkillItem; action: SkillAction }) {
  return (
    <Notice tone="info" announce={false}>
      <div className="flex min-w-0 flex-col gap-3">
        <p>
          <span className="font-medium">Warthog updated this skill since you changed it.</span> Use its new version in place
          of your wording, or keep yours.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ChangeForm skill={skill} change="use_new" action={action}>
            <FormSubmit size="sm" pendingLabel="Saving…">
              Use Warthog&apos;s new version<Named>{` of ${skill.title}`}</Named>
            </FormSubmit>
          </ChangeForm>
          <ChangeForm skill={skill} change="keep_mine" action={action}>
            <FormSubmit variant="secondary" size="sm" pendingLabel="Saving…">
              Keep mine<Named>{` for ${skill.title}`}</Named>
            </FormSubmit>
          </ChangeForm>
        </div>
        <details className="min-w-0">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 font-medium text-fg underline underline-offset-4 [&::-webkit-details-marker]:hidden">
            See Warthog&apos;s version<Named>{` of ${skill.title}`}</Named>
          </summary>
          <div className="flex min-w-0 flex-col gap-2 rounded-card bg-surface-muted p-4">
            <p className="font-medium text-fg">When to use this</p>
            <p className="text-fg-muted [overflow-wrap:anywhere]">{useWhenLine(skill.warthogUseThisWhen)}</p>
            <p className="font-medium text-fg">Instructions</p>
            <p className="whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{skill.warthogGuidance}</p>
          </div>
        </details>
      </div>
    </Notice>
  );
}

// One of Warthog's skills: the summary says what it is and how it stands; opened, it shows the
// fixed rules, the guidance and every control.
function SkillCard({
  skill,
  agents,
  action,
  open,
}: {
  skill: WarthogSkillItem;
  agents: readonly SkillAgent[];
  action: SkillAction;
  open: boolean;
}) {
  const id = `warthog-skill-${skill.key}`;
  const restore = restoreCopy(skill);
  const on = skill.state === "on";
  return (
    <details id={id} open={open || undefined} className="group min-w-0">
      <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3 py-3 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-fg [overflow-wrap:anywhere]">{skill.title}</span>
            <span className="flex flex-wrap items-center gap-2">
              <Badges skill={skill} />
            </span>
          </span>
          <span className="text-sm text-fg-muted [overflow-wrap:anywhere]">{useWhenLine(skill.useThisWhen)}</span>
        </span>
        <ChevronDown aria-hidden={true} className={`mt-1 ${ICON} text-fg-muted transition-transform group-open:rotate-180`} />
      </summary>

      <div className="flex min-w-0 flex-col gap-4 pb-4">
        {skill.updateAvailable ? <UpdateNotice skill={skill} action={action} /> : null}

        {skill.rules.length ? (
          <div className="flex min-w-0 flex-col gap-2 rounded-card bg-surface-muted p-4">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <Lock aria-hidden={true} className={`${ICON} text-fg-muted`} />
              Always applies
            </h4>
            <p className="text-sm text-fg-muted">Warthog&apos;s rules for every agent. They apply whatever this skill says.</p>
            <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-fg [overflow-wrap:anywhere]">
              {skill.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-col gap-2">
          <h4 className="text-sm font-semibold text-fg">Instructions</h4>
          <p className="whitespace-pre-wrap text-sm text-fg [overflow-wrap:anywhere]">{skill.guidance}</p>
        </div>

        {skill.adds || skill.needs ? (
          <div className="flex min-w-0 flex-col gap-1 text-xs text-fg-muted">
            {skill.adds ? <p>{skill.adds}</p> : null}
            {skill.needs ? <p>{onlyFor(skill.needs)}</p> : null}
          </div>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ChangeForm skill={skill} change={on ? "off" : "on"} action={action}>
            <FormSubmit variant="secondary" size="sm" pendingLabel="Saving…">
              {on ? <PowerOff aria-hidden={true} className={ICON} /> : <Power aria-hidden={true} className={ICON} />}
              {on ? "Switch off" : "Switch on"}
              <Named>{` ${skill.title}`}</Named>
            </FormSubmit>
          </ChangeForm>

          <details className={ROW_DISCLOSURE}>
            <summary className={ROW_SUMMARY}>
              <Pencil aria-hidden={true} className={ICON} />
              Edit<Named>{` ${skill.title}`}</Named>
            </summary>
            <ChangeForm skill={skill} change="edit" action={action} className={DISCLOSURE_PANEL}>
              <PendingFormFields>
                <Field
                  name="useThisWhen"
                  label="When to use this"
                  hint={`Agents read this line to decide whether to open the skill. Up to ${USE_THIS_WHEN_MAX} characters.`}
                  required
                  pattern={NOT_BLANK}
                  maxLength={USE_THIS_WHEN_MAX}
                  defaultValue={skill.useThisWhen}
                />
                <TextareaField
                  name="guidance"
                  label="Instructions"
                  hint={`Up to 20,000 characters.${skill.rules.length ? " The rules under Always applies stay as they are." : ""}`}
                  rows={12}
                  required
                  maxLength={GUIDANCE_MAX}
                  defaultValue={skill.guidance}
                />
              </PendingFormFields>
              <div className="flex flex-wrap items-center gap-2">
                <FormSubmit pendingLabel="Saving…">
                  <Save aria-hidden={true} className={ICON} />
                  Save changes<Named>{` to ${skill.title}`}</Named>
                </FormSubmit>
              </div>
            </ChangeForm>
          </details>

          <details className={ROW_DISCLOSURE}>
            <summary className={ROW_SUMMARY}>
              <Users aria-hidden={true} className={ICON} />
              Who gets it<Named>{`: ${skill.title}`}</Named>
            </summary>
            <ChangeForm skill={skill} change="scope" action={action} className={DISCLOSURE_PANEL}>
              <PendingFormFields>
                <fieldset className="flex min-w-0 flex-col">
                  <legend className="sr-only">Who gets it</legend>
                  <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
                    <input type="radio" name="scope" value="all" defaultChecked={skill.scope === "all"} className={ICON} />
                    All agents
                  </label>
                  <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
                    <input type="radio" name="scope" value="chosen" defaultChecked={skill.scope === "chosen"} className={ICON} />
                    Only these agents
                  </label>
                  {agents.length ? (
                    <fieldset className="ms-7 flex min-w-0 flex-col">
                      <legend className="sr-only">Your agents</legend>
                      {agents.map((agent) => (
                        <label key={agent.id} className="flex min-h-11 items-center gap-3 text-sm text-fg [overflow-wrap:anywhere]">
                          <input
                            type="checkbox"
                            name="scopedAgentIds"
                            value={agent.id}
                            defaultChecked={skill.scopedAgentIds.includes(agent.id)}
                            className={ICON}
                          />
                          {agent.displayName}
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                </fieldset>
                <p className="text-sm text-fg-muted">
                  {agents.length
                    ? "Ticked agents get it when you choose Only these agents. With none ticked, no agent gets it."
                    : "Connect an agent to choose it here."}
                </p>
              </PendingFormFields>
              <div className="flex flex-wrap items-center gap-2">
                <FormSubmit pendingLabel="Saving…">
                  <Save aria-hidden={true} className={ICON} />
                  Save<Named>{` who gets ${skill.title}`}</Named>
                </FormSubmit>
              </div>
            </ChangeForm>
          </details>

          {restore ? (
            <details className={ROW_DISCLOSURE}>
              <summary className={ROW_SUMMARY}>
                <RotateCcw aria-hidden={true} className={ICON} />
                Restore Warthog&apos;s version<Named>{` of ${skill.title}`}</Named>
              </summary>
              <ChangeForm skill={skill} change="restore" action={action} className={DISCLOSURE_PANEL}>
                <p className="text-sm text-fg">{restore}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <FormSubmit size="sm" pendingLabel="Restoring…">
                    <RotateCcw aria-hidden={true} className={ICON} />
                    Restore<Named>{` ${skill.title}`}</Named>
                  </FormSubmit>
                </div>
              </ChangeForm>
            </details>
          ) : null}

          <ChangeForm skill={skill} change="remove" action={action}>
            <FormSubmit variant="danger" size="sm" pendingLabel="Removing…">
              <Trash2 aria-hidden={true} className={ICON} />
              Remove<Named>{` ${skill.title}`}</Named>
            </FormSubmit>
          </ChangeForm>
        </div>
      </div>
    </details>
  );
}

export function WarthogSkills({
  skills,
  agents = [],
  changeAction,
  openKey,
}: {
  skills: readonly WarthogSkillItem[];
  // The person's agents, for Who gets it.
  agents?: readonly SkillAgent[];
  // The page's server action; every form here posts to it.
  changeAction?: SkillAction;
  // The skill just changed, whose card opens again after the page reloads.
  openKey?: string;
}) {
  if (skills.length === 0) return null;
  const action = changeAction ?? noAction;
  const choosable = agents.filter((agent) => agent.status !== "disconnected");
  const removed = skills.filter((skill) => skill.state === "removed");
  return (
    <WorkspacePanel
      title="Warthog's skills"
      description="Warthog writes these for your agents. Change the wording, switch one off or choose which agents get it."
    >
      {GROUPS.map(({ group, title, summary }) => {
        const shown = skills.filter((skill) => skill.group === group && skill.state !== "removed");
        return shown.length ? (
          <ListGroup key={group} id={`warthog-skills-${group}`} title={title} count={shown.length} summary={summary} level={3}>
            {shown.map((skill) => (
              <li key={skill.key} className="min-w-0 border-b border-line last:border-0">
                <SkillCard skill={skill} agents={choosable} action={action} open={skill.key === openKey} />
              </li>
            ))}
          </ListGroup>
        ) : null;
      })}
      {removed.length ? (
        <ListGroup
          id="warthog-skills-removed"
          title="Removed"
          count={removed.length}
          summary="Agents don't get these. Restoring one brings back Warthog's version."
          level={3}
        >
          {removed.map((skill) => (
            <li key={skill.key} className={`${LIST_ROW} gap-3 sm:flex-row sm:items-center sm:justify-between`}>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="font-medium text-fg">{skill.title}</p>
                <p className="text-sm text-fg-muted">{useWhenLine(skill.useThisWhen)}</p>
              </div>
              <ChangeForm skill={skill} change="restore" action={action} className="shrink-0">
                <FormSubmit variant="secondary" size="sm" pendingLabel="Restoring…">
                  <RotateCcw aria-hidden={true} className={ICON} />
                  Restore<Named>{` ${skill.title}`}</Named>
                </FormSubmit>
              </ChangeForm>
            </li>
          ))}
        </ListGroup>
      ) : null}
    </WorkspacePanel>
  );
}
