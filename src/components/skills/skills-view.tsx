"use client";

import * as React from "react";
import {
  Pencil,
  Copy,
  Plus,
  Power,
  PowerOff,
  Save,
  Check,
  Layers,
  FileText,
  Download,
} from "lucide-react";

import { ViewPanels } from "@/components/ui/view-tabs";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Card } from "@/components/ui/card";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { Notice, PageNotice, type NoticeTone } from "@/components/ui/notice";
import { loadPackageAction } from "@/app/(portal)/(protected)/skills/library-actions";
import { EmptyState } from "@/components/ui/empty";
import { AgentScope, type SkillAgent } from "./agent-scope";
import { DeleteSkillControl } from "./delete-skill";
import { useWhenLine } from "./use-when";
import { WarthogSkills, type WarthogSkillItem } from "./warthog-skills";
import { LibraryCard, LibraryHeading } from "./library-card";
import { PackageImport, CreatePackage } from "./package-import";
import { PackageModal, downloadBlob } from "./package-editor";
import { AgentSkillsToCheck } from "./agent-skills-to-check";
import type { SkillSuggestionView } from "@/server/skills/agent-skills";
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
// Warthog's own skills (the house skill, the Life admin skills and the defaults) follow the
// person's library in their own section (./warthog-skills), as cards that open the same editor
// a package does: each one's guidance can be edited, switched off, scoped, removed and
// restored, and its fixed rules are shown read-only. The library's search and its Show filter
// (on, off, yours, Warthog's) cover both. Colour comes from the design tokens (globals.css) —
// never a raw hex.

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

export type SkillsViewProps = {
  initialView?: string;
  skills: ReadonlyArray<SkillsViewSkill>;
  packages?: ReadonlyArray<PackageSummary>;
  agents?: ReadonlyArray<SkillAgent>;
  preferences: SkillsViewPreferences | null;
  // Warthog's own skills as they stand for this person.
  warthogSkills?: ReadonlyArray<WarthogSkillItem>;
  // Changes agents suggest to the person's skills (docs/adr/agent-saved-skills.md).
  suggestions?: ReadonlyArray<SkillSuggestionView>;
  // Controls bound to the server actions the page passes. OPTIONAL: the view renders
  // its controls live regardless (they submit to these when supplied); the page always
  // supplies them, so in the running app every control acts — never a dead button.
  // The outcome of the last action, in plain words (the page maps `?notice=`).
  notice?: { readonly tone: NoticeTone; readonly text: string } | null;
  saveProfileAction?: SkillAction;
  createSkillAction?: SkillAction;
  editSkillAction?: SkillAction;
  duplicateSkillAction?: SkillAction;
  toggleSkillAction?: SkillAction;
  deleteSkillAction?: SkillAction;
  useSuggestionAction?: SkillAction;
  keepSkillAction?: SkillAction;
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

// A form needs a function action; in a prop-only render (a preview, a render test) with no
// action supplied, nothing is stored.
const noAction = async (_formData: FormData): Promise<void> => {};

// A value of only spaces counts as empty (the server trims before it checks too).
const NOT_BLANK = ".*\\S.*";

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
  return (
    <>
      <Field
        name="title"
        label="Title"
        placeholder="Name this skill"
        required
        pattern={NOT_BLANK}
        maxLength={200}
        width="text"
        defaultValue={skill?.title}
      />
      <Field
        name="useThisWhen"
        label="When to use this"
        placeholder="e.g. when I ask you to restock the kitchen"
        required
        pattern={NOT_BLANK}
        maxLength={500}
        defaultValue={skill?.useThisWhen}
      />
      <TextareaField
        name="fullText"
        label="Full instructions"
        rows={4}
        required
        maxLength={20_000}
        placeholder="What should agents do, step by step?"
        defaultValue={skill?.fullText ?? ""}
      />
      <AgentScope
        agents={agents}
        scope={skill?.scope}
        selected={skill?.scopedAgentIds}
      />
    </>
  );
}

// Focus the library list (after a skill card has left the page with its deleted skill). Found
// in the document rather than through a ref, so it also works when the refreshed page has
// mounted a new list.
function focusLibrary(): void {
  document.querySelector<HTMLElement>("[data-skill-library]")?.focus({ preventScroll: true });
}

// Edit opens underneath the card's action row (see the memory rows): where the browser
// supports it the <details> lets its summary sit in the row and its panel span the width.
const ROW_DISCLOSURE =
  "min-w-0 open:basis-full supports-[selector(::details-content)]:contents details-content:basis-full details-content:order-last not-open:details-content:hidden";

// One of the person's skills, as a card: its title, its scope and on/off state, its
// use-this-when line and one action row — Edit (a disclosure revealing the content form),
// Duplicate, Switch off (or on), Download and Delete. Each control submits to the server
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
    <Card className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium text-fg [overflow-wrap:anywhere]">
          {skill.title}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{skill.scope === "all" ? "All agents" : "Chosen agents"}</Badge>
          {skill.enabled ? (
            <Badge tone="success" icon={Check}>
              On
            </Badge>
          ) : (
            <Badge icon={PowerOff}>Off</Badge>
          )}
        </div>
      </div>

      <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{useWhenLine(skill.useThisWhen)}</p>

      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-2">
        <details className={ROW_DISCLOSURE}>
          <summary className={`${buttonClasses({ variant: "secondary", size: "sm" })} list-none [&::-webkit-details-marker]:hidden`}>
            <Pencil aria-hidden={true} className="h-4 w-4 shrink-0" />
            Edit
            <span className="sr-only"> {skill.title}</span>
          </summary>
          <ActionForm action={editSkillAction ?? noAction} className="flex min-w-0 flex-col gap-3 rounded-card bg-surface-muted p-4">
            <input type="hidden" name="id" value={skill.id} />
            <PendingFormFields>
              <SkillFields skill={skill} agents={agents} />
            </PendingFormFields>
            <div className="flex flex-wrap items-center gap-2">
              <FormSubmit pendingLabel="Saving…">
                <Save aria-hidden={true} className="h-4 w-4 shrink-0" />
                Save changes
              </FormSubmit>
            </div>
          </ActionForm>
        </details>
        <ActionForm action={duplicateSkillAction ?? noAction}>
          <input type="hidden" name="id" value={skill.id} />
          <FormSubmit variant="secondary" size="sm" pendingLabel="Duplicating…">
            <Copy aria-hidden={true} className="h-4 w-4 shrink-0" />
            Duplicate
            <span className="sr-only"> {skill.title}</span>
          </FormSubmit>
        </ActionForm>
        <ActionForm action={toggleSkillAction ?? noAction}>
          <input type="hidden" name="id" value={skill.id} />
          <input
            type="hidden"
            name="enabled"
            value={skill.enabled ? "false" : "true"}
          />
          <FormSubmit variant="secondary" size="sm" pendingLabel="Saving…">
            {skill.enabled ? (
              <>
                <PowerOff aria-hidden={true} className="h-4 w-4 shrink-0" />
                Switch off
                <span className="sr-only"> {skill.title}</span>
              </>
            ) : (
              <>
                <Power aria-hidden={true} className="h-4 w-4 shrink-0" />
                Switch on
                <span className="sr-only"> {skill.title}</span>
              </>
            )}
          </FormSubmit>
        </ActionForm>
        <Button
          variant="secondary"
          size="sm"
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
          <Download aria-hidden className="h-4 w-4 shrink-0" />
          Download
          <span className="sr-only"> {skill.title}</span>
        </Button>
        {/* Delete asks first, in an in-page dialog naming the skill (./delete-skill). */}
        <DeleteSkillControl
          action={deleteSkillAction ?? noAction}
          skillId={skill.id}
          title={skill.title}
          onDeleted={focusLibrary}
        />
      </div>
    </Card>
  );
}

export function SkillsView({
  initialView,
  skills,
  packages = [],
  agents = [],
  preferences,
  warthogSkills = [],
  suggestions = [],
  notice,
  saveProfileAction,
  editSkillAction,
  duplicateSkillAction,
  toggleSkillAction,
  deleteSkillAction,
  useSuggestionAction,
  keepSkillAction,
}: SkillsViewProps) {
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [page, setPage] = React.useState(0);
  const [draft, setDraft] = React.useState<
    ParsedPackage | StoredPackage | null
  >(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const openingRef = React.useRef(false);
  const modalOpener = React.useRef<HTMLElement | null>(null);
  const restoreOpener = React.useRef(false);
  const libraryHeading = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    if (draft !== null || !restoreOpener.current) return;
    restoreOpener.current = false;
    const target = modalOpener.current?.isConnected ? modalOpener.current : libraryHeading.current;
    target?.focus({ preventScroll: true });
  }, [draft]);
  const [loadError, setLoadError] = React.useState("");
  const [skipped, setSkipped] = React.useState<string[]>([]);
  // Open a package in the editor, from its library card or from Waiting for you.
  const openPackage = async (id: string, opener: HTMLElement) => {
    if (openingRef.current) return;
    // Capture the initiating control before the asynchronous load can move focus or render
    // a modal.
    modalOpener.current = opener;
    openingRef.current = true;
    setOpening(id);
    setLoadError("");
    try {
      const result = await loadPackageAction(id);
      if (result.ok) {
        setDraft(result.value);
        setSkipped([]);
      } else setLoadError(result.error);
    } catch {
      setLoadError("We couldn't open that package. Please try again.");
    } finally {
      openingRef.current = false;
      setOpening(null);
    }
  };
  // Who saved a skill or suggests a change, by the name the person gave the agent.
  const agentName = (agentId: string | undefined) =>
    agents.find((a) => a.id === agentId)?.displayName ?? "an agent that's no longer connected";
  const waitingPackages = packages.filter((p) => p.awaitingCheck);
  const packagedIds = new Set(
    packages.flatMap((p) => p.members.map((m) => m.skillId)),
  );
  const standalone = skills.filter((s) => !packagedIds.has(s.id));
  const includes = (text: string) =>
    text.toLowerCase().includes(query.trim().toLowerCase());
  // Show: everything, what's switched on or off, only the person's own, or only Warthog's.
  const matchesStatus = (enabled: boolean) =>
    status === "on" ? enabled : status === "off" ? !enabled : true;
  const showYours = status !== "warthog";
  // Warthog's are all skills, never plugins.
  const showWarthog = status !== "yours" && kind !== "plugin";
  const enabledCount = (p: PackageSummary) =>
    p.members.filter((m) => skills.some((s) => s.id === m.skillId && s.enabled))
      .length;
  const visiblePackages = packages.filter(
    (p) =>
      showYours &&
      (kind === "all" || kind === p.kind) &&
      matchesStatus(enabledCount(p) > 0) &&
      includes(
        [p.name, p.description, ...p.skills.map((s) => s.name)].join(" "),
      ),
  );
  const visibleSkills = standalone.filter(
    (s) =>
      showYours &&
      kind !== "plugin" &&
      matchesStatus(s.enabled) &&
      includes(`${s.title} ${s.useThisWhen}`),
  );
  const warthogInLibrary = warthogSkills.filter((s) => s.state !== "removed");
  const visibleWarthog = warthogInLibrary.filter(
    (s) => showWarthog && matchesStatus(s.state === "on") && includes(`${s.title} ${s.useThisWhen}`),
  );
  // A removed skill is off for every agent; it's listed apart, under Warthog's.
  const removedWarthog = warthogSkills.filter(
    (s) => s.state === "removed" && showWarthog && status !== "on" && includes(`${s.title} ${s.useThisWhen}`),
  );
  const ownMatched = visiblePackages.length + visibleSkills.length;
  const matchedCount = ownMatched + visibleWarthog.length;
  // Only the person's own skills are paged; Warthog's follow them in full.
  const pageCount = Math.max(1, Math.ceil(ownMatched / 24));
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
  const total = count + warthogInLibrary.length;
  // With nothing of their own yet, the library says how to start (unless a search or
  // Warthog's-only view is narrowing it).
  const noOwnYet = count === 0 && (status === "all" || status === "yours") && !query.trim();
  const plugins = packages.filter((p) => p.kind === "plugin").length;
  // The person's skills and Warthog's count together, as the library shows them together.
  const skillCount = skills.length + warthogInLibrary.length;
  const switchedOn = skills.filter((s) => s.enabled).length + warthogInLibrary.filter((s) => s.state === "on").length;
  // "3 skills · 1 switched on"; plugins are named only when the library holds one.
  const meta = [
    `${skillCount} ${skillCount === 1 ? "skill" : "skills"}`,
    ...(plugins > 0 ? [`${plugins} ${plugins === 1 ? "plugin" : "plugins"}`] : []),
    `${switchedOn} switched on`,
  ].join(" · ");
  const itemsNoun = plugins > 0 ? "skills and plugins" : total === 1 ? "skill" : "skills";
  const clearFilters = () => {
    setQuery("");
    setKind("all");
    setStatus("all");
    setPage(0);
  };
  // The outcome of the last action leads whichever tab is open, straight under the band.
  const outcome = notice ? <PageNotice tone={notice.tone} clearParams={["notice"]}>{notice.text}</PageNotice> : null;
  return (
    <>
      <ViewPanels
        label="Skills views"
        initialTab={initialView}
        heading={{
          title: "Skills",
          description:
            "Instructions that help your agents work your way. Write one in plain words, or bring skills you already use.",
          meta,
          // Creating is the heading's one action once there is a library; an empty
          // library's own empty state carries it instead (never two primaries at once).
          actions: count > 0 ? (
            <ButtonLink href="/skills?view=add" variant="primary">
              <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
              Create a skill
            </ButtonLink>
          ) : undefined,
        }}
        tabs={[
          {
            key: "library",
            label: "Library",
            content: (
              <>
                {outcome}
                {loadError && <Notice tone="error">{loadError}</Notice>}
                {opening && <Notice tone="info">Opening package…</Notice>}
                <AgentSkillsToCheck
                  drafts={waitingPackages}
                  suggestions={suggestions}
                  agentName={agentName}
                  opening={opening}
                  onOpen={(id, opener) => void openPackage(id, opener)}
                  useSuggestionAction={useSuggestionAction}
                  keepSkillAction={keepSkillAction}
                />
                {total > 0 ? (
                  <ListToolbar
                    label="Find skills"
                    search={
                      <Field
                        label="Search your library"
                        type="search"
                        value={query}
                        onChange={(e) => {
                          setQuery(e.target.value);
                          setPage(0);
                        }}
                        placeholder={plugins > 0 ? "Find a skill or plugin…" : "Find a skill…"}
                      />
                    }
                    more={
                      <div className="flex flex-wrap items-end gap-3">
                        {plugins > 0 ? (
                          <SelectField
                            id="library-kind"
                            label="Type"
                            width="short"
                            value={kind}
                            onChange={(e) => {
                              setKind(e.target.value);
                              setPage(0);
                            }}
                          >
                            <option value="all">All types</option>
                            <option value="skill">Skills</option>
                            <option value="plugin">Plugins</option>
                          </SelectField>
                        ) : null}
                        <SelectField
                          id="library-status"
                          label="Show"
                          width="short"
                          value={status}
                          onChange={(e) => {
                            setStatus(e.target.value);
                            setPage(0);
                          }}
                        >
                          <option value="all">All</option>
                          <option value="on">Switched on</option>
                          <option value="off">Switched off</option>
                          <option value="yours">Yours</option>
                          <option value="warthog">Warthog&apos;s</option>
                        </SelectField>
                      </div>
                    }
                    status={`Showing ${matchedCount} of ${total} ${itemsNoun}.`}
                  />
                ) : null}
                <div ref={libraryHeading} tabIndex={-1} data-skill-library="" className="flex min-w-0 flex-col gap-6 outline-none sm:gap-8">
                  {!total || (!matchedCount && !removedWarthog.length && noOwnYet) ? (
                    <EmptyState
                      heading="No skills of your own yet"
                      description="A skill is a short set of instructions with a line saying when to use it. Write one, or import skills you already have."
                      action={
                        <ButtonLink href="/skills?view=add" variant="primary">
                          Create or import a skill
                        </ButtonLink>
                      }
                    />
                  ) : !matchedCount && !removedWarthog.length ? (
                    <EmptyState
                      heading={plugins > 0 ? "No matching skills or plugins" : "No matching skills"}
                      description="Try a different name or clear your filters."
                      action={
                        <Button variant="secondary" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <>
                      {ownMatched > 0 || noOwnYet ? (
                        <section aria-labelledby="your-skills-heading" className="flex min-w-0 flex-col gap-4">
                          <LibraryHeading id="your-skills-heading" title="Your skills" count={ownMatched} />
                          {ownMatched === 0 ? (
                            <EmptyState
                              headingLevel={3}
                              heading="No skills of your own yet"
                              description="A skill is a short set of instructions with a line saying when to use it. Write one, or import skills you already have."
                              action={
                                <ButtonLink href="/skills?view=add" variant="primary">
                                  Create or import a skill
                                </ButtonLink>
                              }
                            />
                          ) : (
                            <ul role="list" className="grid min-w-0 gap-4 md:grid-cols-2">
                              {pagedPackages.map((p) => (
                                <li key={p.id} className="min-w-0">
                                  <LibraryCard
                                    icon={p.kind === "plugin" ? Layers : FileText}
                                    name={p.name}
                                    kind={p.kind === "plugin" ? "Plugin" : "Skill"}
                                    description={p.description}
                                    facts={[
                                      `${p.skills.length} ${p.skills.length === 1 ? "skill" : "skills"} · ${p.fileCount} ${p.fileCount === 1 ? "file" : "files"}`,
                                      p.awaitingCheck
                                        ? `Saved by ${agentName(p.savedByAgentId)} · waiting for you`
                                        : !p.members.length
                                          ? "Files only"
                                          : enabledCount(p)
                                            ? `${enabledCount(p)} switched on`
                                            : "Switched off",
                                    ]}
                                    opening={opening === p.id}
                                    busy={Boolean(opening) && opening !== p.id}
                                    onOpen={(opener) => void openPackage(p.id, opener)}
                                  />
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
                          )}
                          {pageCount > 1 && (
                            <nav aria-label="Library pages" className="wh-form-actions">
                              <div className="wh-form-actions-buttons">
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  disabled={currentPage === 0}
                                  onClick={() => setPage(currentPage - 1)}
                                >
                                  Previous page
                                </Button>
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  disabled={currentPage + 1 === pageCount}
                                  onClick={() => setPage(currentPage + 1)}
                                >
                                  Next page
                                </Button>
                              </div>
                              <p role="status">
                                Page {currentPage + 1} of {pageCount}. Search covers your whole library.
                              </p>
                            </nav>
                          )}
                        </section>
                      ) : null}
                      <WarthogSkills skills={visibleWarthog} removed={removedWarthog} agents={agents} />
                    </>
                  )}
                </div>
              </>
            ),
          },
          {
            key: "add",
            label: "Import & create",
            content: (
              <div className="contents" onClickCapture={(event) => {
                if (draft) return;
                const button = event.target instanceof Element ? event.target.closest("button") : null;
                if (button instanceof HTMLElement) modalOpener.current = button;
              }} onSubmitCapture={(event) => {
                if (draft) return;
                const submitter = (event.nativeEvent as SubmitEvent).submitter;
                if (submitter instanceof HTMLElement) modalOpener.current = submitter;
              }}>
                {outcome}
                <CreatePackage onReady={ready} />
                <PackageImport onReady={ready} />
              </div>
            ),
          },
          {
            key: "preferences",
            label: "Preferences",
            content: (
              <>
                {outcome}
                <ActionForm action={saveProfileAction ?? noAction}>
                  <WorkspacePanel
                    title="Preferences"
                    description="How you like your agents to communicate with you. Fill in all six to save them."
                    footer={
                      <FormSubmit pendingLabel="Saving…">
                        <Save aria-hidden className="h-4 w-4" />
                        Save preferences
                      </FormSubmit>
                    }
                  >
                    <PendingFormFields>
                      <div className="grid gap-4 sm:grid-cols-2">
                        {PROFILE_FIELDS.map((f) => (
                          <Field
                            key={f.key}
                            name={f.key}
                            label={f.label}
                            placeholder={f.placeholder}
                            required
                            pattern={NOT_BLANK}
                            maxLength={2000}
                            defaultValue={
                              preferences ? preferences[f.key] : undefined
                            }
                          />
                        ))}
                      </div>
                    </PendingFormFields>
                  </WorkspacePanel>
                </ActionForm>
              </>
            ),
          },
        ]}
      />
      {draft && (
        <PackageModal
          key={"id" in draft ? draft.id : draft.name}
          draft={draft}
          skills={skills}
          agents={agents}
          skipped={skipped}
          savedBy={(() => {
            const waiting = "id" in draft ? waitingPackages.find((p) => p.id === draft.id) : undefined;
            const name = waiting ? agentName(waiting.savedByAgentId) : undefined;
            return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
          })()}
          onDuplicate={ready}
          onClose={() => {
            restoreOpener.current = true;
            setDraft(null);
          }}
          onSaved={() => window.location.reload()}
        />
      )}
    </>
  );
}

export default SkillsView;
