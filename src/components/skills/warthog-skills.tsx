"use client";

import * as React from "react";
import { Check, FileText, Lock, Pencil, PowerOff, RefreshCw, RotateCcw, Save, Trash2, Users, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { changeWarthogSkillAction } from "@/app/(portal)/(protected)/skills/warthog-actions";
import { AgentScope, SKILL_CONTROL, type SkillAgent } from "./agent-scope";
import { LibraryCard, LibraryHeading } from "./library-card";
import { EDITOR_FOOTER, EDITOR_HEADER, EditorViews, SkillDialog } from "./package-editor";
import { createPackageOperation } from "./package-operation";
import { useWhenLine } from "./use-when";

// Warthog's own skills on the Skills page (docs/adr/editable-builtin-skills.md), shown and
// managed the way the person's own skills are (founder, 27 Nov 2026): a card each, in three
// groups, and a card opens the same editor dialog — Preview, Edit, Agent access, with Restore
// and Remove in its footer. The fixed rules are shown read-only. Removed skills are listed
// apart, each with Restore.
//
// Every change goes to `changeWarthogSkillAction` (../../app/(portal)/(protected)/skills/
// warthog-actions.ts), which checks the session and hands it to the seam's
// `changeWarthogSkill`; a saved change reloads the page, as a saved package does.

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

// The seam's limits (skills actions), so the editor stops the person before the server does.
const USE_THIS_WHEN_MAX = 500;
const GUIDANCE_MAX = 20_000;
const ICON = "h-4 w-4 shrink-0";

export const WARTHOG_GROUPS: ReadonlyArray<{ group: WarthogSkillItem["group"]; title: string; summary: string }> = [
  { group: "warthog", title: "How agents use Warthog", summary: "Warthog's own guides for your agents. Switched on to start." },
  { group: "everyday", title: "Everyday", summary: "Help with everyday jobs. Switched on to start." },
  { group: "pack", title: "Packs", summary: "Off until you switch one on." },
];

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
  if (skill.scope === "chosen") parts.push("gives it back to all agents");
  return `Restoring ${listed(parts)}.`;
}

// "Agents that can read your calendar" → "Only for agents that can read your calendar."
function onlyFor(needs: string): string {
  return `Only for ${needs.charAt(0).toLowerCase()}${needs.slice(1)}.`;
}

// The card's footer facts, in words.
export function warthogFacts(skill: WarthogSkillItem): string[] {
  return [
    ...(skill.edited ? ["Edited by you"] : []),
    ...(skill.scope === "chosen" ? ["Chosen agents"] : []),
    skill.state === "on" ? "Switched on" : "Switched off",
  ];
}

// How the skill stands, in words (never colour alone), under the editor's title.
function Badges({ skill }: { skill: WarthogSkillItem }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
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
    </div>
  );
}

type Send = (change: Record<string, unknown>, after: () => void) => void;

// Warthog changed this skill after the person edited it: take the new version, keep theirs, or
// read Warthog's first.
function UpdateNotice({ skill, send, onSaved }: { skill: WarthogSkillItem; send: Send; onSaved: () => void }) {
  return (
    <Notice tone="info" announce={false}>
      <div className="flex min-w-0 flex-col gap-3">
        <p>
          <span className="font-medium">Warthog updated this skill since you changed it.</span> Use its new version in place
          of your wording, or keep yours.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => send({ action: "use_new" }, onSaved)}>
            Use Warthog&apos;s new version<Named>{` of ${skill.title}`}</Named>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => send({ action: "keep_mine" }, onSaved)}>
            Keep mine<Named>{` for ${skill.title}`}</Named>
          </Button>
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

// The fixed rules, read-only.
function Rules({ skill }: { skill: WarthogSkillItem }) {
  if (!skill.rules.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-card bg-surface-muted p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Lock aria-hidden={true} className={`${ICON} text-fg-muted`} />
        Always applies
      </h3>
      <p className="text-sm text-fg-muted">
        Warthog&apos;s rules for every agent. They apply whatever this skill says.
        {skill.key === "using_warthog" ? " Every agent gets them, even if you switch this skill off or remove it." : null}
      </p>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-fg [overflow-wrap:anywhere]">
        {skill.rules.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
    </div>
  );
}

const TITLE_ID = "warthog-skill-dialog-title";

// One of Warthog's skills in the editor: Preview (the rules, the instructions, who it's for),
// Edit (the use-this-when line and the instructions) and Agent access (on or off, and which
// agents), as the person's own skills have. The footer restores Warthog's version, removes it
// or saves the edit.
export function WarthogSkillEditor({
  skill: initial,
  agents,
  onClose,
  onSaved,
}: {
  skill: WarthogSkillItem;
  agents: readonly SkillAgent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [skill, setSkill] = React.useState(initial);
  const [mode, setMode] = React.useState<"preview" | "edit" | "access">("preview");
  const [useThisWhen, setUseThisWhen] = React.useState(initial.useThisWhen);
  const [guidance, setGuidance] = React.useState(initial.guidance);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [confirm, setConfirm] = React.useState<"remove" | "restore" | "close" | null>(null);
  const [accessChanged, setAccessChanged] = React.useState(false);
  const operationRef = React.useRef<ReturnType<typeof createPackageOperation> | null>(null);
  if (!operationRef.current) operationRef.current = createPackageOperation({ onBusy: setBusy, onError: setError });
  const operation = operationRef.current;
  const uid = React.useId();
  const dirty = useThisWhen !== initial.useThisWhen || guidance !== initial.guidance;
  const validation = !useThisWhen.trim()
    ? "Say when agents should use this skill."
    : !guidance.trim()
      ? "Write the instructions."
      : "";
  const restore = restoreCopy(skill);
  const send: Send = (change, after) =>
    void operation.run(async () => {
      const result = await changeWarthogSkillAction({ key: skill.key, ...change });
      if (result.ok) after();
      else {
        setError(result.error);
        setConfirm(null);
      }
    });
  const close = () => (accessChanged ? onSaved() : onClose());
  const requestClose = () => {
    if (operation.isBusy()) return;
    if (dirty) setConfirm("close");
    else close();
  };
  // Native dialog Escape is routed through the same unsaved-edits check.
  React.useEffect(() => {
    const handle = (e: Event) => {
      e.preventDefault();
      if (!busy) requestClose();
    };
    const dialog = document.getElementById(uid)?.closest("dialog");
    dialog?.addEventListener("cancel", handle);
    return () => dialog?.removeEventListener("cancel", handle);
  });
  const group = WARTHOG_GROUPS.find((g) => g.group === skill.group)?.title;

  return (
    <div id={uid} className="flex min-w-0 flex-col gap-5">
      <header className={EDITOR_HEADER}>
        <div className="min-w-0">
          <p className="mb-1 text-sm text-fg-muted">Warthog&apos;s skills{group ? ` · ${group}` : ""}</p>
          <h2 id={TITLE_ID} className="text-xl font-semibold [overflow-wrap:anywhere]">
            {skill.title}
          </h2>
          <p className="mt-2 text-sm text-fg-muted [overflow-wrap:anywhere]">{useWhenLine(useThisWhen || skill.useThisWhen)}</p>
          <Badges skill={skill} />
        </div>
        <Button variant="secondary" onClick={requestClose} disabled={busy} aria-label="Close editor" className="shrink-0 px-3">
          <X aria-hidden className="h-5 w-5" />
        </Button>
      </header>

      {confirm && (
        <Notice tone="warning">
          <p>
            {confirm === "remove"
              ? "Remove this skill? Your agents stop getting it. It stays under Removed, and you can restore it any time."
              : confirm === "restore"
                ? `${restore ?? "Restoring puts back Warthog's version."}${dirty ? " Your unsaved edits are lost." : ""}`
                : "Discard your unsaved changes?"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" autoFocus onClick={() => setConfirm(null)}>
              Keep editing
            </Button>
            <Button
              variant={confirm === "remove" ? "danger-solid" : "secondary"}
              disabled={busy}
              onClick={() => {
                if (confirm === "close") close();
                else send({ action: confirm }, onSaved);
              }}
            >
              {confirm === "remove" ? "Yes, remove it" : confirm === "restore" ? "Yes, restore it" : "Discard changes"}
            </Button>
          </div>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {busy && (
        <p role="status" className="text-sm text-fg-muted">
          Please wait while your skill is updated.
        </p>
      )}

      <fieldset disabled={busy} className="contents">
        <EditorViews
          label="Skill views"
          mode={mode}
          onChange={setMode}
          views={[
            ["preview", "Preview"],
            ["edit", "Edit"],
            ["access", "Agent access"],
          ]}
        />

        {mode === "preview" ? (
          <div className="flex min-w-0 flex-col gap-4">
            {skill.updateAvailable ? <UpdateNotice skill={skill} send={send} onSaved={onSaved} /> : null}
            <Rules skill={skill} />
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-semibold text-fg">Instructions</h3>
              <pre tabIndex={0} className="max-h-96 min-h-56 overflow-auto whitespace-pre-wrap rounded-card bg-surface-muted p-4 font-sans text-sm leading-relaxed [overflow-wrap:anywhere]">
                {guidance}
              </pre>
            </div>
            {skill.adds || skill.needs ? (
              <div className="flex min-w-0 flex-col gap-1 text-xs text-fg-muted">
                {skill.adds ? <p>{skill.adds}</p> : null}
                {skill.needs ? <p>{onlyFor(skill.needs)}</p> : null}
              </div>
            ) : null}
          </div>
        ) : mode === "edit" ? (
          <div className="flex min-w-0 flex-col gap-3">
            <Field
              label="When to use this"
              hint={`Agents read this line to decide whether to open the skill. Up to ${USE_THIS_WHEN_MAX} characters.`}
              value={useThisWhen}
              maxLength={USE_THIS_WHEN_MAX}
              onChange={(e) => setUseThisWhen(e.target.value)}
            />
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-guidance`}>Instructions</Label>
              <textarea
                id={`${uid}-guidance`}
                className={`${SKILL_CONTROL} min-h-64 leading-relaxed`}
                maxLength={GUIDANCE_MAX}
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
              />
              <p className="text-xs text-fg-muted">
                Up to 20,000 characters.{skill.rules.length ? " Warthog's rules under Always applies stay as they are." : ""}
              </p>
            </div>
          </div>
        ) : (
          <form
            className="max-w-xl space-y-3 rounded-card border border-line p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const access = {
                enabled: form.get("enabled") === "on",
                scope: form.get("scope") === "chosen" ? ("chosen" as const) : ("all" as const),
                scopedAgentIds: form.getAll("scopedAgentIds").map(String),
              };
              setMessage("");
              send({ action: "access", ...access }, () => {
                setSkill((s) => ({ ...s, state: access.enabled ? "on" : "off", scope: access.scope, scopedAgentIds: access.scope === "chosen" ? access.scopedAgentIds : [] }));
                setAccessChanged(true);
                setMessage("Access saved.");
              });
            }}
          >
            <h3 className="font-medium [overflow-wrap:anywhere]">{skill.title}</h3>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={skill.state === "on"} className="h-4 w-4" />
              Available to agents
            </label>
            <AgentScope agents={agents} scope={skill.scope} selected={skill.scopedAgentIds} />
            {skill.needs ? <p className="text-sm text-fg-muted">{onlyFor(skill.needs)}</p> : null}
            <Button variant="secondary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save access"}
            </Button>
            {message && (
              <p role="status" className="text-sm">
                {message}
              </p>
            )}
          </form>
        )}
      </fieldset>

      {mode === "edit" && validation && <Notice tone="warning">{validation}</Notice>}
      <footer className={EDITOR_FOOTER}>
        <div className="flex flex-wrap gap-2">
          {restore ? (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirm("restore")}>
              <RotateCcw aria-hidden className="h-4 w-4" />
              Restore Warthog&apos;s version
            </Button>
          ) : null}
          <Button variant="danger" disabled={busy} onClick={() => setConfirm("remove")}>
            <Trash2 aria-hidden className="h-4 w-4" />
            Remove skill
          </Button>
        </div>
        <Button
          disabled={!dirty || Boolean(validation)}
          aria-disabled={busy}
          className="aria-disabled:opacity-50"
          onClick={() => send({ action: "edit", useThisWhen, guidance }, onSaved)}
        >
          <Save aria-hidden className="h-4 w-4" />
          {busy ? "Working…" : "Save changes"}
        </Button>
      </footer>
    </div>
  );
}

// Warthog's skills in the library: a heading, then each group's cards, then any removed ones.
// `skills` and `removed` are what the library's search and filters leave.
export function WarthogSkills({
  skills,
  removed = [],
  agents = [],
}: {
  skills: readonly WarthogSkillItem[];
  removed?: readonly WarthogSkillItem[];
  // The person's agents, for Agent access.
  agents?: readonly SkillAgent[];
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const opener = React.useRef<HTMLElement | null>(null);
  const returnFocus = React.useRef(false);
  React.useLayoutEffect(() => {
    if (open !== null || !returnFocus.current) return;
    returnFocus.current = false;
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  }, [open]);
  if (skills.length === 0 && removed.length === 0) return null;
  const choosable = agents.filter((agent) => agent.status !== "disconnected");
  const editing = skills.find((skill) => skill.key === open);
  const reload = () => window.location.reload();

  return (
    <section aria-labelledby="warthog-skills-heading" className="flex min-w-0 flex-col gap-4">
      <LibraryHeading
        id="warthog-skills-heading"
        title="Warthog's skills"
        count={skills.length}
        summary="Warthog writes these for your agents. Change the wording, switch one off or choose which agents get it."
      />
      {WARTHOG_GROUPS.map(({ group, title, summary }) => {
        const shown = skills.filter((skill) => skill.group === group);
        return shown.length ? (
          <section key={group} aria-labelledby={`warthog-skills-${group}-heading`} className="flex min-w-0 flex-col gap-3">
            <LibraryHeading id={`warthog-skills-${group}-heading`} title={title} count={shown.length} summary={summary} level={3} />
            <ul role="list" className="grid min-w-0 gap-4 md:grid-cols-2">
              {shown.map((skill) => (
                <li key={skill.key} className="min-w-0">
                  <LibraryCard
                    icon={FileText}
                    name={skill.title}
                    kind="Warthog"
                    notes={
                      skill.updateAvailable ? (
                        <Badge tone="info" icon={RefreshCw}>
                          Warthog updated this
                        </Badge>
                      ) : null
                    }
                    description={useWhenLine(skill.useThisWhen)}
                    facts={warthogFacts(skill)}
                    onOpen={(element) => {
                      opener.current = element;
                      setOpen(skill.key);
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null;
      })}
      {removed.length ? (
        <section aria-labelledby="warthog-skills-removed-heading" className="flex min-w-0 flex-col gap-3">
          <LibraryHeading
            id="warthog-skills-removed-heading"
            title="Removed"
            count={removed.length}
            summary="Agents don't get these. Restoring one brings back Warthog's version."
            level={3}
          />
          {error && <Notice tone="error">{error}</Notice>}
          <ul role="list" className="flex min-w-0 flex-col rounded-card border border-line bg-surface px-4">
            {removed.map((skill) => (
              <li key={skill.key} className="flex min-w-0 flex-col gap-3 border-b border-line py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="font-medium text-fg [overflow-wrap:anywhere]">{skill.title}</p>
                  <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{useWhenLine(skill.useThisWhen)}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  disabled={restoring !== null}
                  onClick={async () => {
                    setRestoring(skill.key);
                    setError("");
                    try {
                      const result = await changeWarthogSkillAction({ key: skill.key, action: "restore" });
                      if (result.ok) return reload();
                      setError(result.error);
                    } catch {
                      setError("We couldn't restore that skill. Please try again.");
                    }
                    setRestoring(null);
                  }}
                >
                  <RotateCcw aria-hidden={true} className={ICON} />
                  {restoring === skill.key ? "Restoring…" : "Restore"}
                  <Named>{` ${skill.title}`}</Named>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {editing ? (
        <SkillDialog
          labelledBy={TITLE_ID}
          onClose={() => {
            returnFocus.current = true;
            setOpen(null);
          }}
        >
          {(dismiss) => <WarthogSkillEditor key={editing.key} skill={editing} agents={choosable} onClose={dismiss} onSaved={reload} />}
        </SkillDialog>
      ) : null}
    </section>
  );
}
