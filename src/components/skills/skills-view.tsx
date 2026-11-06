"use client";

import * as React from "react";
import { Pencil, Copy, Trash2, Plus, Power, PowerOff, Lock, Save, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";

// E13-S07 — Skills view component (brief "Skills, preferences and shared memory";
// design §4.1).
//
// The Skills screen is where a person writes a communication-style PREFERENCES
// PROFILE (tone, length, language, units, time zone, teaching/briefing) and a set of
// named SKILLS (each a title, a one-line "use this when" line, a scope of all/chosen
// agents and an on/off state). This is the PURE, prop-driven VIEW (a Client Component
// in the app): it renders the profile form and every skill FROM PROPS, each skill
// carrying create / edit / duplicate / switch-off / delete controls, so it can be
// pinned without a browser, a session or any server plumbing — exactly the precedent
// the sibling rules / identity / consent views set.
//
// The real persistence/apply plumbing (saving the profile, creating / editing /
// duplicating / switching off / deleting a skill) lives in the server composition
// root and a sibling actions module wired by a LATER task; THIS component renders the
// screen from the props the Skills page read (E13-S06 `skillsPageData`) hands it.
//
// Warthog's own HOUSE SKILL is shown ALWAYS INCLUDED and READ-ONLY — it is not one of
// the person's skills, so it can never be switched off, scoped out, edited or deleted
// and offers none of those controls. Its wording comes through the prop from the
// one-source-of-truth domain constant `HOUSE_SKILL`. Colour comes from the design
// tokens (globals.css) — never a raw hex.

// One of the person's own skills, as the Skills page read (E13-S06 SkillsPageItem)
// hands it back: its id, its decrypted title + "use this when" line, its scope (all
// agents or a chosen set, with the chosen agent ids) and its on/off state.
export type SkillsViewSkill = {
  id: string;
  title: string;
  useThisWhen: string;
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
};

// The six communication-style attributes the profile form reads back, each labelled in
// plain words (so the form is usable even when no profile is saved yet) with a short
// hint for the empty case.
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

// One of the person's skills, as a card: its title, its scope and on/off state, its
// use-this-when line and its live edit / duplicate / switch-off (or on) / delete
// controls.
function SkillCard({ skill }: { skill: SkillsViewSkill }) {
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
        <Button variant="secondary" type="button">
          <Pencil aria-hidden={true} className="h-4 w-4 shrink-0" />
          Edit
        </Button>
        <Button variant="secondary" type="button">
          <Copy aria-hidden={true} className="h-4 w-4 shrink-0" />
          Duplicate
        </Button>
        {skill.enabled ? (
          <Button variant="secondary" type="button">
            <PowerOff aria-hidden={true} className="h-4 w-4 shrink-0" />
            Switch off
          </Button>
        ) : (
          <Button variant="secondary" type="button">
            <Power aria-hidden={true} className="h-4 w-4 shrink-0" />
            Switch on
          </Button>
        )}
        <Button variant="secondary" type="button">
          <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
          Delete
        </Button>
      </div>
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

export function SkillsView({ skills, preferences, houseSkill }: SkillsViewProps) {
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

        <div className="flex flex-col gap-4">
          {PROFILE_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              placeholder={f.placeholder}
              defaultValue={preferences ? preferences[f.key] : undefined}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" type="button">
            <Save aria-hidden={true} className="h-4 w-4 shrink-0" />
            Save profile
          </Button>
        </div>
      </div>

      {/* ----- Skills: the house skill (always included) then the person's own ----- */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-fg">Your skills</h2>
          <Button variant="primary" type="button">
            <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
            Create skill
          </Button>
        </div>

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
                <SkillCard skill={skill} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default SkillsView;
