"use client";

import * as React from "react";
import {
  Pencil,
  Copy,
  Trash2,
  Plus,
  Power,
  PowerOff,
  Lock,
  Save,
  Check,
  Layers,
  FileText,
  Download,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Label } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { loadPackageAction } from "@/app/(portal)/(protected)/skills/library-actions";
import { EmptyState } from "@/components/ui/empty";
import { Field as SearchField } from "@/components/ui/field";
import { AgentScope, type SkillAgent } from "./agent-scope";
import { PackageImport, CreatePackage } from "./package-import";
import { PackageModal, downloadBlob } from "./package-editor";
import { makeSkillFile, type ParsedPackage } from "@/domain/skills/package";
import type { StoredPackage, PackageSummary } from "@/server/db/skill-packages";

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
  packages?: ReadonlyArray<PackageSummary>;
  agents?: ReadonlyArray<SkillAgent>;
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
  {
    key: "length",
    label: "Length",
    placeholder: "How long should replies be?",
  },
  { key: "language", label: "Language", placeholder: "Which language?" },
  {
    key: "units",
    label: "Units",
    placeholder: "Which units and measurements?",
  },
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
  "w-full rounded-card border border-line-input bg-surface px-3 text-base sm:text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The content fields a skill carries — title, use-this-when line, full instructions and
// scope — shared by the create and edit forms (one source of truth for the fields).
// Pre-filled on edit, with a named picker for the person's connected agents.
function SkillFields({
  skill,
  agents = [],
}: {
  skill?: SkillsViewSkill;
  agents?: readonly SkillAgent[];
}) {
  const uid = React.useId();
  const fullTextId = `${uid}-full-text`;
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
      <AgentScope
        agents={agents}
        scope={skill?.scope}
        selected={skill?.scopedAgentIds}
      />
    </>
  );
}

// One of the person's skills, as a card: its title, its scope and on/off state, its
// use-this-when line and its live duplicate / switch-off (or on) / delete controls plus
// an edit disclosure that reveals the content form. Each control submits to the server
// action the page passes, carrying this skill's id.
function SkillCard({
  skill,
  agents = [],
  editSkillAction,
  duplicateSkillAction,
  toggleSkillAction,
  deleteSkillAction,
}: {
  skill: SkillsViewSkill;
  agents?: readonly SkillAgent[];
  editSkillAction?: SkillAction;
  duplicateSkillAction?: SkillAction;
  toggleSkillAction?: SkillAction;
  deleteSkillAction?: SkillAction;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium text-fg [overflow-wrap:anywhere]">
          {skill.title}
        </h3>
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
          <input
            type="hidden"
            name="enabled"
            value={skill.enabled ? "false" : "true"}
          />
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
        <form
          action={deleteSkillAction}
          onSubmit={(e) => {
            if (
              !window.confirm(
                "Delete this skill? Your agents will lose access immediately.",
              )
            )
              e.preventDefault();
          }}
        >
          <input type="hidden" name="id" value={skill.id} />
          <Button variant="secondary" type="submit">
            <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Delete
          </Button>
        </form>
      </div>

      <Button
        variant="secondary"
        onClick={() =>
          downloadBlob(
            new Blob(
              [
                makeSkillFile(
                  skill.title,
                  skill.useThisWhen,
                  skill.fullText ?? "",
                ),
              ],
              { type: "text/markdown" },
            ),
            "SKILL.md",
          )
        }
      >
        <Download aria-hidden className="h-4 w-4" />
        Download skill
      </Button>
      <details className="flex flex-col gap-3">
        <summary className="inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-fg">
          <Pencil aria-hidden={true} className="h-4 w-4 shrink-0" />
          Edit
        </summary>
        <form action={editSkillAction} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={skill.id} />
          <SkillFields skill={skill} agents={agents} />
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
  packages = [],
  agents = [],
  preferences,
  houseSkill,
  saveProfileAction,
  editSkillAction,
  duplicateSkillAction,
  toggleSkillAction,
  deleteSkillAction,
}: SkillsViewProps) {
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [page, setPage] = React.useState(0);
  const [draft, setDraft] = React.useState<
    ParsedPackage | StoredPackage | null
  >(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [skipped, setSkipped] = React.useState<string[]>([]);
  const packagedIds = new Set(
    packages.flatMap((p) => p.members.map((m) => m.skillId)),
  );
  const standalone = skills.filter((s) => !packagedIds.has(s.id));
  const includes = (text: string) =>
    text.toLowerCase().includes(query.trim().toLowerCase());
  const matchesStatus = (enabled: boolean) =>
    status === "all" || (status === "on" ? enabled : !enabled);
  const enabledCount = (p: PackageSummary) =>
    p.members.filter((m) => skills.some((s) => s.id === m.skillId && s.enabled))
      .length;
  const visiblePackages = packages.filter(
    (p) =>
      (kind === "all" || kind === p.kind) &&
      matchesStatus(enabledCount(p) > 0) &&
      includes(
        [p.name, p.description, ...p.skills.map((s) => s.name)].join(" "),
      ),
  );
  const visibleSkills = standalone.filter(
    (s) =>
      kind !== "plugin" &&
      matchesStatus(s.enabled) &&
      includes(`${s.title} ${s.useThisWhen}`),
  );
  const matchedCount = visiblePackages.length + visibleSkills.length;
  const pageCount = Math.max(1, Math.ceil(matchedCount / 24));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * 24,
    end = start + 24;
  const pagedPackages = visiblePackages.slice(start, end);
  const pagedSkills = visibleSkills.slice(
    Math.max(0, start - visiblePackages.length),
    Math.max(0, end - visiblePackages.length),
  );
  const ready = (p: ParsedPackage, omitted: string[] = []) => {
    setDraft(p);
    setSkipped(omitted);
  };
  const count = packages.length + standalone.length;
  return (
    <section className="flex min-w-0 flex-col gap-6">
      <header>
        <p className="mb-2 text-sm text-fg-muted">Your personal library</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Skills &amp; plugins
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
          Keep the instructions that make your agents work your way. Bring what
          you already use, or create something of your own.
        </p>
        <p className="mt-3 text-sm text-fg-muted">
          {skills.length} skills ·{" "}
          {packages.filter((p) => p.kind === "plugin").length}{" "}
          {packages.filter((p) => p.kind === "plugin").length === 1
            ? "plugin"
            : "plugins"}{" "}
          · {skills.filter((s) => s.enabled).length} switched on
        </p>
      </header>
      <PackageImport onReady={ready} />
      {loadError && <Notice tone="error">{loadError}</Notice>}
      {opening && (
        <p role="status" className="text-sm">
          Opening package…
        </p>
      )}
      <CreatePackage onReady={ready} />
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <div className="col-span-2 sm:col-span-1">
            <SearchField
              label="Search your library"
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder="Find a skill or plugin…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="library-kind">Type</Label>
            <select
              id="library-kind"
              className={`${CONTROL_BASE} min-h-11`}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All types</option>
              <option value="skill">Skills</option>
              <option value="plugin">Plugins</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="library-status">Availability</Label>
            <select
              id="library-status"
              className={`${CONTROL_BASE} min-h-11`}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All</option>
              <option value="on">Switched on</option>
              <option value="off">Switched off</option>
            </select>
          </div>
        </div>
        <p className="text-sm text-fg-muted" role="status">
          {visiblePackages.length + visibleSkills.length} of {count} library
          items
        </p>
        {!count ? (
          <EmptyState
            heading="No skills yet"
            description="Import a skill or plugin you already use, or create your first skill above."
          />
        ) : !visiblePackages.length && !visibleSkills.length ? (
          <div className="rounded-card border border-line bg-surface p-6">
            <p className="font-medium">No matching skills or plugins</p>
            <p className="mt-1 text-sm text-fg-muted">
              Try a different name or clear your filters.
            </p>
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() => {
                setQuery("");
                setKind("all");
                setStatus("all");
                setPage(0);
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : null}
        <ul className="grid min-w-0 gap-4 md:grid-cols-2">
          {pagedPackages.map((p) => (
            <li key={p.id} className="min-w-0">
              <button
                type="button"
                className="flex h-full min-h-44 w-full flex-col gap-3 rounded-card border border-line bg-surface p-4 text-start transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                disabled={Boolean(opening)}
                onClick={async () => {
                  setOpening(p.id);
                  setLoadError("");
                  try {
                    const result = await loadPackageAction(p.id);
                    if (result.ok) {
                      setDraft(result.value);
                      setSkipped([]);
                    } else setLoadError(result.error);
                  } catch {
                    setLoadError(
                      "Could not open that package. Please try again.",
                    );
                  } finally {
                    setOpening(null);
                  }
                }}
              >
                <div className="flex w-full items-start justify-between gap-3">
                  <span className="flex min-w-0 items-start gap-3">
                    {p.kind === "plugin" ? (
                      <Layers
                        aria-hidden
                        className="mt-1 h-5 w-5 shrink-0 text-accent"
                      />
                    ) : (
                      <FileText
                        aria-hidden
                        className="mt-1 h-5 w-5 shrink-0 text-accent"
                      />
                    )}
                    <span className="font-semibold [overflow-wrap:anywhere]">
                      {p.name}
                    </span>
                  </span>
                  <span className="shrink-0 rounded bg-surface-muted px-2 py-1 text-xs text-fg-muted">
                    {p.kind === "plugin" ? "Plugin" : "Skill"}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
                  {p.description}
                </p>
                <div className="mt-auto flex w-full flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 text-xs text-fg-muted">
                  <span>
                    {p.skills.length}{" "}
                    {p.skills.length === 1 ? "skill" : "skills"} · {p.fileCount}{" "}
                    {p.fileCount === 1 ? "file" : "files"}
                  </span>
                  <span>
                    {!p.members.length
                      ? "Files only"
                      : enabledCount(p)
                        ? `${enabledCount(p)} switched on`
                        : "Switched off"}
                  </span>
                  <span className="ms-auto text-sm font-medium text-fg">
                    Open &amp; edit →
                  </span>
                </div>
              </button>
            </li>
          ))}
          {pagedSkills.map((skill) => (
            <li key={skill.id} className="min-w-0">
              <SkillCard
                skill={skill}
                agents={agents}
                editSkillAction={editSkillAction}
                duplicateSkillAction={duplicateSkillAction}
                toggleSkillAction={toggleSkillAction}
                deleteSkillAction={deleteSkillAction}
              />
            </li>
          ))}
        </ul>
        {pageCount > 1 && (
          <nav
            aria-label="Library pages"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <Button
              type="button"
              variant="secondary"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous page
            </Button>
            <span className="text-sm text-fg-muted" role="status">
              Page {currentPage + 1} of {pageCount}. Search covers your whole
              library.
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={currentPage + 1 === pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next page
            </Button>
          </nav>
        )}
      </div>
      <details className="rounded-card border border-line bg-surface p-4">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">
          Your style profile
        </summary>
        <p className="mt-2 text-sm text-fg-muted">
          How you like your agents to communicate with you.
        </p>
        <form
          action={saveProfileAction}
          className="mt-4 flex max-w-2xl flex-col gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
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
          <div>
            <Button variant="secondary" type="submit">
              <Save aria-hidden className="h-4 w-4" />
              Save profile
            </Button>
          </div>
        </form>
      </details>
      <HouseSkillCard houseSkill={houseSkill} />
      {draft && (
        <PackageModal
          key={"id" in draft ? draft.id : draft.name}
          draft={draft}
          skills={skills}
          agents={agents}
          skipped={skipped}
          onDuplicate={ready}
          onClose={() => setDraft(null)}
          onSaved={() => window.location.reload()}
        />
      )}
    </section>
  );
}

export default SkillsView;
