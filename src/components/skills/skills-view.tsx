"use client";

import * as React from "react";
import { Pencil, Copy, Trash2, Plus, Power, PowerOff, Lock, Save, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";

// E13-S07 — Skills view component (brief "Skills, preferences and shared memory";
// design §4.1). E13-S08 wired every control to the server actions the page passes.
//
// The Skills screen is where a person writes a communication-style PREFERENCES
// PROFILE (tone, length, language, units, time zone, teaching/briefing) and a set of
// named SKILLS (each a title, a one-line "use this when" line, the full instruction
// text, a scope of all/chosen agents and an on/off state). This is the PURE,
// prop-driven VIEW (a Client Component in the app): it renders the profile form and
// every skill FROM PROPS, each skill carrying create / edit / duplicate / switch-off /
// delete controls, so it can be pinned without a browser, a session or any server
// plumbing — exactly the precedent the sibling rules / identity / consent / connectors
// views set.
//
// Each control is a `<form action={…}>` bound to one of the server actions the page
// passes (`saveProfileAction`, `createSkillAction`, `editSkillAction`,
// `duplicateSkillAction`, `toggleSkillAction`, `deleteSkillAction`) — the actions are
// OPTIONAL props so the view stays render-testable without a server, and the page
// always supplies them so no control is dead in the running app. Submitting a control
// carries the owned skill's id (and, for a toggle, the new on/off state) to the action,
// which persists member-scoped and reloads the screen.
//
// Warthog's own HOUSE SKILL is shown ALWAYS INCLUDED and READ-ONLY — it is not one of
// the person's skills, so it can never be switched off, scoped out, edited or deleted
// and offers none of those controls. Its wording comes through the prop from the
// one-source-of-truth domain constant `HOUSE_SKILL`. Colour comes from the design
// tokens (globals.css) — never a raw hex.

// A control bound to a server action: submits its form to the action the page passes.
type SkillAction = (formData: FormData) => void | Promise<void>;

// One of the person's own skills, as the Skills page read (E13-S06 SkillsPageItem)
// hands it back: its id, its decrypted title + "use this when" line + full instruction
// text, its scope (all agents or a chosen set, with the chosen agent ids) and its
// on/off state. `fullText` is optional so the render-test fixtures (which pin the list,
// not the edit body) need not carry it.
export type SkillsViewSkill = {
  id: string;
  title: string;
  useThisWhen: string;
  fullText?: string;
  scope: "all" | "chosen";
  scopedAgentIds: string[];
  enabled: boolean;
};

// The person's communication-style profile, or null when none is saved yet.
export type SkillsViewPreferences = {
  userId: string;
  tone: string;
  length: string;
  language: string;
  units: string;
  timeZone: string;
  briefing: string;
};

// Warthog's own house skill marker — always included for every agent, read-only.
export type SkillsViewHouseSkill = {
  title: string;
  useThisWhen: string;
  alwaysIncluded: true;
};

export type SkillsViewProps = {
  skills: ReadonlyArray<SkillsViewSkill>;
  preferences: SkillsViewPreferences | null;
  houseSkill: SkillsViewHouseSkill;
  // Controls bound to the server actions the page passes. OPTIONAL: the view renders
  // its controls live regardless (they submit to these when supplied); the page always
  // supplies them, so in the running app every control acts — never a dead button.
  saveProfileAction?: SkillAction;
  createSkillAction?: SkillAction;
  editSkillAction?: SkillAction;
  duplicateSkillAction?: SkillAction;
  toggleSkillAction?: SkillAction;
  deleteSkillAction?: SkillAction;
};

// The six communication-style attributes the profile form reads back, each labelled in
// plain words (so the form is usable even when no profile is saved yet) with a short
// hint for the empty case. The `key` doubles as the form field name the save action
// reads.
const PROFILE_FIELDS: ReadonlyArray<{
  key: Exclude<keyof SkillsViewPreferences, "userId">;
  label: string;
  placeholder: string;
}> = [
  { key: "tone", label: "Tone", placeholder: "How should agents sound?" },
  { key: "length", label: "Length", placeholder: "How long should replies be?" },
  { key: "language", label: "Language", placeholder: "Which language?" },
  { key: "units", label: "Units", placeholder: "Which units and measurements?" },
  { key: "timeZone", label: "Time zone", placeholder: "Your time zone" },
  {
    key: "briefing",
    label: "Teaching and briefing",
    placeholder: "How do you like to learn and be briefed?",
  },
];

// A multi-line / select control styled on the same tokens as the shared Input primitive
// (≥44px target, token colour/border/focus) — no raw colour. Used for the full
// instruction text and the scope chooser, which the Input primitive does not cover.
const CONTROL_BASE =
  "w-full rounded-card border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The content fields a skill carries — title, use-this-when line, full instructions and
// scope — shared by the create and edit forms (one source of truth for the fields).
// Pre-filled from `skill` on edit, empty on create. A chosen skill's existing agent ids
// are carried through as hidden fields so an edit that does not change them preserves
// them (the screen offers no agent picker yet — the loader hands it no agent list).
function SkillFields({ skill }: { skill?: SkillsViewSkill }) {
  const uid = React.useId();
  const fullTextId = `${uid}-full-text`;
  const scopeId = `${uid}-scope`;
  return (
    <>
      <Field
        name="title"
        label="Title"
        placeholder="Name this skill"
        defaultValue={skill?.title}
      />
      <Field
        name="useThisWhen"
        label="When to use this"
        placeholder="e.g. when I ask you to restock the kitchen"
        defaultValue={skill?.useThisWhen}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fullTextId}>Full instructions</Label>
        <textarea
          id={fullTextId}
          name="fullText"
          rows={4}
          className={`${CONTROL_BASE} min-h-24 py-2`}
          placeholder="What should agents do, step by step?"
          defaultValue={skill?.fullText ?? ""}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={scopeId}>Which agents</Label>
        <select
          id={scopeId}
          name="scope"
          className={`${CONTROL_BASE} min-h-11`}
          defaultValue={skill?.scope ?? "all"}
        >
          <option value="all">All agents</option>
          <option value="chosen">Chosen agents</option>
        </select>
      </div>
      {(skill?.scopedAgentIds ?? []).map((agentId) => (
        <input key={agentId} type="hidden" name="scopedAgentIds" value={agentId} />
      ))}
    </>
  );
}

// One of the person's skills, as a card: its title, its scope and on/off state, its
// use-this-when line and its live duplicate / switch-off (or on) / delete controls plus
// an edit disclosure that reveals the content form. Each control submits to the server
// action the page passes, carrying this skill's id.
function SkillCard({
  skill,
  editSkillAction,
  duplicateSkillAction,
  toggleSkillAction,
  deleteSkillAction,
}: {
  skill: SkillsViewSkill;
  editSkillAction?: SkillAction;
  duplicateSkillAction?: SkillAction;
  toggleSkillAction?: SkillAction;
  deleteSkillAction?: SkillAction;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium text-fg">{skill.title}</h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-fg-muted">
            {skill.scope === "all" ? "All agents" : "Chosen agents"}
          </span>
          {skill.enabled ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
              <Check aria-hidden={true} className="h-4 w-4 shrink-0" />
              On
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted">
              <PowerOff aria-hidden={true} className="h-4 w-4 shrink-0" />
              Off
            </span>
          )}
        </div>
      </div>

      <p className="text-sm text-fg-muted">{skill.useThisWhen}</p>

      <div className="flex flex-wrap items-center gap-2">
        <form action={duplicateSkillAction}>
          <input type="hidden" name="id" value={skill.id} />
          <Button variant="secondary" type="submit">
            <Copy aria-hidden={true} className="h-4 w-4 shrink-0" />
            Duplicate
          </Button>
        </form>
        <form action={toggleSkillAction}>
          <input type="hidden" name="id" value={skill.id} />
          <input type="hidden" name="enabled" value={skill.enabled ? "false" : "true"} />
          <Button variant="secondary" type="submit">
            {skill.enabled ? (
              <>
                <PowerOff aria-hidden={true} className="h-4 w-4 shrink-0" />
                Switch off
              </>
            ) : (
              <>
                <Power aria-hidden={true} className="h-4 w-4 shrink-0" />
                Switch on
              </>
            )}
          </Button>
        </form>
        <form action={deleteSkillAction}>
          <input type="hidden" name="id" value={skill.id} />
          <Button variant="secondary" type="submit">
            <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Delete
          </Button>
        </form>
      </div>

      <details className="flex flex-col gap-3">
        <summary className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-fg">
          <Pencil aria-hidden={true} className="h-4 w-4 shrink-0" />
          Edit
        </summary>
        <form action={editSkillAction} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={skill.id} />
          <SkillFields skill={skill} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" type="submit">
              <Save aria-hidden={true} className="h-4 w-4 shrink-0" />
              Edit skill
            </Button>
          </div>
        </form>
      </details>
    </Card>
  );
}

// Warthog's own house skill — always included for every agent and read-only: its title
// and use-this-when are shown, it is marked always-included in words, and it offers
// NONE of the edit / duplicate / switch / delete controls.
function HouseSkillCard({ houseSkill }: { houseSkill: SkillsViewHouseSkill }) {
  return (
    <Card className="flex flex-col gap-3 bg-surface-muted">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="inline-flex items-center gap-2 font-medium text-fg">
          <Lock aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
          {houseSkill.title}
        </h3>
        <span className="text-sm font-medium text-fg-muted">
          Always included · Read-only
        </span>
      </div>
      <p className="text-sm text-fg-muted">{houseSkill.useThisWhen}</p>
    </Card>
  );
}

export function SkillsView({
  skills,
  preferences,
  houseSkill,
  saveProfileAction,
  createSkillAction,
  editSkillAction,
  duplicateSkillAction,
  toggleSkillAction,
  deleteSkillAction,
}: SkillsViewProps) {
  return (
    <section className="flex flex-col gap-8">
      {/* ----- Preferences profile: a person's communication-style profile ----- */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-fg">Your style profile</h1>
          <p className="text-sm text-fg-muted">
            How you like your agents to communicate with you.
          </p>
        </div>

        <form action={saveProfileAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-4">
            {PROFILE_FIELDS.map((f) => (
              <Field
                key={f.key}
                name={f.key}
                label={f.label}
                placeholder={f.placeholder}
                defaultValue={preferences ? preferences[f.key] : undefined}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" type="submit">
              <Save aria-hidden={true} className="h-4 w-4 shrink-0" />
              Save profile
            </Button>
          </div>
        </form>
      </div>

      {/* ----- Skills: create, the house skill (always included), then the person's ----- */}
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Your skills</h2>

        <details className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <summary className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-fg">
            <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
            Create a skill
          </summary>
          <form action={createSkillAction} className="flex flex-col gap-3">
            <SkillFields />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" type="submit">
                <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
                Create skill
              </Button>
            </div>
          </form>
        </details>

        <HouseSkillCard houseSkill={houseSkill} />

        {skills.length === 0 ? (
          <EmptyState
            heading="No skills yet"
            description="Your named skills will appear here once you create one."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {skills.map((skill) => (
              <li key={skill.id}>
                <SkillCard
                  skill={skill}
                  editSkillAction={editSkillAction}
                  duplicateSkillAction={duplicateSkillAction}
                  toggleSkillAction={toggleSkillAction}
                  deleteSkillAction={deleteSkillAction}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default SkillsView;
