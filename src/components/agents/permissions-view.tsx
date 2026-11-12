import type { PermissionsSection } from "@/domain/permissions/workspace";
import { CONNECTION_CAPABILITIES } from "@/domain/permissions/connection-choices";
import { Select } from "@/components/ui/select";
import * as React from "react";
import { ChevronDown, CreditCard, Plug, Sparkles, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { ActionBar } from "@/components/shell/workspace-surfaces";
import {
  DEFAULT_CARD_BUDGET,
  budgetAllowsCard,
  type Budget,
} from "@/domain/budget/budget";
import { ruleSentence, type Rule } from "@/domain/rules/rules";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { RuleKindBadge } from "@/components/rules/rule-badges";
import { ConnectorModule } from "./connector-module";

// E10-S07 — Per-agent permissions view (design §7; brief "Per-agent permissions
// page"). Each agent's reach is shaped on ONE screen. For a given agent the person
// sees which connected services and which of their tools it may use (read tools and
// change-making tools listed SEPARATELY, change-making tools defaulting to "Ask me
// first"), which identity fields it may read without asking (low tier only) and
// whether it may request high-tier fields, whether it may request a card and its
// spending budget (card access cannot be switched on without a budget; the budget
// defaults to A$200 per month), which skills it receives, whether it may read shared
// memory, whether what it learns is shared with other agents, its own rules, and
// (under Advanced) its request limit (default 120 per minute).
//
// This is the PURE, prop-driven VIEW: it renders the screen from its props so it can
// be pinned without a browser, a session or any server plumbing. The persistence /
// apply plumbing ("changes take effect on the agent's next request") lives in the
// server composition root and is wired by a later task; the controls here are
// native, user-adjustable form controls whose initial state is driven by the props.
//
// The budget default (A$200 / month) is the one-source-of-truth domain contract
// DEFAULT_CARD_BUDGET, and whether a budget allows card access is budgetAllowsCard —
// this view re-encodes neither. Rules read back as ruleSentence() verbatim. Colour
// comes from the design tokens (globals.css) — never a raw hex.

// The view's own default request limit (brief NFR: "default 120 requests per
// minute, set per agent by the person on that agent's permissions page").
const DEFAULT_REQUEST_LIMIT = 120;

export type ConnectorAccess = {
  accounts?: readonly { id: string; label: string }[];
  accountId?: string;
  policy?: { allowedTools?: string[] | null; readTools?: boolean; changeTools?: "off" | "allow" | "ask_first" };
  id: string;
  name: string;
  // whether the agent may use this connected service (review fix W2.3): when present, the
  // service carries its own toggle; absent ⇒ the service is listed as already granted.
  granted?: boolean;
  // the tool names the agent may use, split into the two groups the brief names:
  // read tools and change-making tools (the latter default to "Ask me first").
  readTools: ReadonlyArray<string>;
  changeTools: ReadonlyArray<string>;
};

export type SkillGrant = { id: string; name: string; granted: boolean };
// A life-admin record the agent may be given: its own name, plus its type in words
// ("Subscription") so two records are never told apart by an enum (interaction-12).
export type RecordGrant = SkillGrant & { description?: string };

export type PermissionsViewProps = {
  // the agent being shaped, named on the screen.
  agentName: string;
  section?: PermissionsSection;
  readTools?: boolean;
  changeTools?: "off" | "allow" | "ask_first";
  memoryWrite?: boolean;
  skillCount?: number;
  nextSkillCursor?: string | null;
  nextMemoryCursor?: string | null;
  identityFields?: readonly string[] | null;
  vaultFields?: ReadonlyArray<SkillGrant & { tier: "low" | "high" }>;
  memories?: ReadonlyArray<SkillGrant>;
  embedded?: boolean;
  saving?: boolean;
  // granted connectors and the tools it may use, reads and changes listed apart.
  connectors: ReadonlyArray<ConnectorAccess>;
  // low-tier identity read (always low tier only) vs. the high-tier REQUEST toggle.
  lowTierRead: boolean;
  highTierRequest: boolean;
  // card access and its spending budget; a null budget means none is set yet.
  cardAccess: boolean;
  budget: Budget | null;
  // which skills it receives, each grantable.
  skills: ReadonlyArray<SkillGrant>;
  // the person's tasks and life-admin records (their own grants, migration 0068).
  resourceControls?: { tasksWrite?: boolean; recordsWrite?: boolean; recordIds?: string[] | null };
  recordChoices?: readonly RecordGrant[];
  tasksAccess: boolean;
  recordsAccess: boolean;
  // read the person's shared memory; share what it learns with other agents.
  sharedMemoryRead: boolean;
  learningSharing: boolean;
  // its own rules, each rendered as its plain-English sentence (ruleSentence).
  rules: ReadonlyArray<Rule>;
  // Advanced: the sliding-window request limit; defaults to 120 requests/min.
  requestLimit?: number;
  // the person's currency label (e.g. "A$").
  currency?: string;
  // A disconnected agent: its settings are shown but can't be saved, and the save bar
  // says why instead of offering Save (interaction-08).
  readOnly?: boolean;
};

// One capability toggle: a native, user-adjustable checkbox whose initial checked
// state reflects the prop. The visible label text IS the control's accessible name; the
// stable `name` is what the save reads it by (never the label text, which is copy).
function Toggle({
  name,
  on,
  label,
  description,
}: {
  name: string;
  on: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 rounded-card border border-line bg-surface p-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={on}
        className="mt-1 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-fg">{label}</span>
        {description ? (
          <span className="text-sm text-fg-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="wh-group-title">{children}</h2>;
}

export function PermissionsView({
  agentName,
  section = "all",
  readTools = true,
  changeTools = "ask_first",
  memoryWrite = false,
  embedded = false,
  saving = false,
  connectors,
  lowTierRead,
  highTierRequest,
  identityFields = null,
  vaultFields = [],
  memories = [],
  cardAccess,
  budget,
  skills,
  resourceControls, recordChoices,
  tasksAccess,
  recordsAccess,
  sharedMemoryRead,
  learningSharing,
  rules,
  requestLimit,
  currency = "A$",
  readOnly = false,
}: PermissionsViewProps) {
  const [vaultScope, setVaultScope] = React.useState(
    identityFields === null ? "all" : "chosen",
  );
  // Card access cannot be switched on without a budget (and that budget must allow
  // it): the save control is disabled with a stated reason until one is set.
  const cardNeedsBudget =
    cardAccess && (budget === null || !budgetAllowsCard(budget));
  const budgetPeriod = budget?.period ?? DEFAULT_CARD_BUDGET.period;
  const limit = requestLimit ?? DEFAULT_REQUEST_LIMIT;

  const show = (part: PermissionsSection) =>
    section === "all" || section === part;
  return (
    <section className="wh-permissions flex flex-col gap-4 sm:gap-6">
      {!embedded ? (
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-fg">
            What {agentName} can do
          </h1>
          <p className="text-sm text-fg-muted">
            Shape {agentName}&rsquo;s reach. Changes take effect on its next
            request.
          </p>
        </header>
      ) : null}

      {show("connectors") ? (
        <>
          {/* Connected services: the agent-wide defaults, then one collapsible module per
              service (reads and changes listed separately inside each). */}
          <div className="wh-permission-group flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <SectionHeading>Connected services</SectionHeading>
              <p className="text-sm text-fg-muted">
                Services you connect belong to you. Choose which ones {agentName} may
                use and how. Connecting a service does not grant agent access.
              </p>
            </div>
            <div className="flex flex-col gap-3 rounded-field bg-surface-muted p-3">
              <p className="text-sm font-medium text-fg">Defaults for every service</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  name="readTools"
                  on={readTools}
                  label="Allow reading from granted services"
                />
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Changes to granted services
                  <Select name="changeTools" defaultValue={changeTools}>
                    <option value="off">Off</option>
                    <option value="ask_first">Ask me first</option>
                    <option value="allow">Allow, subject to rules</option>
                  </Select>
                </label>
              </div>
              <p className="text-xs text-fg-muted">A service set to “Same as this agent’s setting” follows these.</p>
            </div>
            {connectors.length === 0 ? (
              <EmptyState
                variant="inline"
                icon={Plug}
                heading="No services connected yet."
                description={`Connect a service, such as Gmail, then come back to let ${agentName} use it.`}
                action={<ButtonLink href="/connectors" size="sm">Connect a service</ButtonLink>}
              />
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-fg-muted">
                  {connectors.length} {connectors.length === 1 ? "service" : "services"} ·{" "}
                  {connectors.filter((connector) => connector.granted !== false).length} allowed for {agentName}. Open a service to change its access.
                </p>
                {[...connectors]
                  .sort((a, b) => Number(b.granted !== false) - Number(a.granted !== false) || a.name.localeCompare(b.name))
                  .map((connector) => (
                  <ConnectorModule
                    key={connector.id}
                    agentName={agentName}
                    connector={connector}
                    defaultReads={readTools}
                    defaultChanges={changeTools}
                    defaultOpen={connectors.length === 1}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {show("vault") ? (
        <>
          {/* Identity: low-tier read vs. the high-tier REQUEST toggle. */}
          <div className="wh-permission-group flex flex-col gap-3">
            <SectionHeading>Your details</SectionHeading>
            <label className="flex flex-col gap-1 text-sm">
              Which details it can read
              <Select
                name="identityScope"
                value={vaultScope}
                onChange={(event) => setVaultScope(event.target.value)}
              >
                {/* Short labels, so a closed select never clips a word at 320px (mobile-23). */}
                <option value="all">All my details</option>
                <option value="chosen">Only the ones I choose</option>
              </Select>
              <span className="text-xs text-fg-muted">“All my details” includes details you add later.</span>
            </label>
            {vaultScope === "chosen" && (
              <div className="flex flex-col gap-2">
                {vaultFields.map((field) => (
                  <Toggle
                    key={field.id}
                    name={`vaultField:${field.id}`}
                    on={field.granted}
                    label={field.name}
                    description={
                      field.tier === "high"
                        ? "Protected · asks you each time"
                        : "Everyday"
                    }
                  />
                ))}
              </div>
            )}

            <p className="text-sm text-fg-muted">
              These choices apply only to {agentName}. Protected details always
              need your approval.{" "}
              <a href="/vault" className="text-accent underline">
                Manage your details
              </a>
            </p>
            <Toggle
              name="identity"
              on={lowTierRead}
              label="Read your everyday details"
              description={CONNECTION_CAPABILITIES.identity.description}
            />
            <Toggle
              name="highTier"
              on={highTierRequest}
              label="Let it ask for protected details"
              description={CONNECTION_CAPABILITIES.highTier.description}
            />
          </div>
        </>
      ) : null}

      {show("spending") ? (
        <>
          {/* Card access and its spending budget. The budget field shows only alongside
          card access; enabling card access without a budget blocks save. */}
          <div className="wh-permission-group flex flex-col gap-3">
            <SectionHeading>Card access</SectionHeading>
            <Toggle
              name="card"
              on={cardAccess}
              label={
                <span className="inline-flex items-center gap-2">
                  <CreditCard aria-hidden={true} className="h-4 w-4 shrink-0" />
                  Let it ask to use a card
                </span>
              }
              description="You approve each card release. Warthog records the approved amount; the agent makes the purchase outside Warthog."
            />
            {cardAccess ? (
              <Card className="flex flex-col gap-2">
                <Field
                  name="cardBudget"
                  label={`Card budget per ${budgetPeriod} (${currency})`}
                  width="short"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  defaultValue={budget ? budget.amount : undefined}
                  placeholder={String(DEFAULT_CARD_BUDGET.amount)}
                />
                <Field
                  name="cardBudgetCurrency"
                  label="Currency"
                  hint="A three-letter code, such as AUD."
                  width="code"
                  defaultValue={currency}
                  maxLength={3}
                />
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Budget period
                  <Select name="cardBudgetPeriod" defaultValue={budgetPeriod} width="short">
                    <option value="day">Day</option>
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                  </Select>
                </label>
                <p className="text-sm text-fg-muted">
                  Defaults to {currency}
                  {DEFAULT_CARD_BUDGET.amount} per {DEFAULT_CARD_BUDGET.period}.
                </p>
              </Card>
            ) : null}
          </div>
        </>
      ) : null}

      {show("skills") ? (
        <>
          {/* Skills it receives. */}
          <div className="wh-permission-group flex flex-col gap-3">
            <SectionHeading>Skills</SectionHeading>
            <p className="text-sm text-fg-muted">
              Choose which skills {agentName} can use. Your choice here overrides
              the skill&rsquo;s own setting, and skills you&rsquo;ve switched off
              stay off. Warthog&rsquo;s own instructions always apply.
            </p>
            {skills.length === 0 ? (
              <EmptyState
                variant="inline"
                icon={Sparkles}
                heading="No skills are switched on yet."
                description="Skills you add and switch on appear here."
                action={<ButtonLink href="/skills" size="sm">Manage your skills</ButtonLink>}
              />
            ) : (
              <a href="/skills" className="inline-flex min-h-11 items-center self-start text-sm text-accent underline lg:min-h-0">
                Manage your skills
              </a>
            )}
            {skills.map((skill) => (
              <Toggle
                key={skill.id}
                name={`skill:${skill.id}`}
                on={skill.granted}
                label={skill.name}
              />
            ))}
          </div>
        </>
      ) : null}

      {show("settings") ? (
        <>
          {/* The person's tasks and life-admin records — their own grants. */}
          <div className="wh-permission-group flex flex-col gap-3">
            <SectionHeading>Tasks and records</SectionHeading>
            {/* Each "change" switch sits under the access it depends on (content-37). */}
            <Toggle
              name="tasks"
              on={tasksAccess}
              label="Your tasks"
              description="Read tasks assigned to this agent or available to any agent."
            />
            <Toggle name="tasksWrite" on={resourceControls?.tasksWrite !== false} label="Let it add and update tasks" description="Needs “Your tasks” on. Turn off to let it read tasks only." />
            <Toggle
              name="records"
              on={recordsAccess}
              label="Your life-admin records"
              description="Read the records chosen below."
            />
            <Toggle name="recordsWrite" on={resourceControls?.recordsWrite !== false} label="Let it save and update records" description="Needs “Your life-admin records” on. Turn off to let it read records only." />
            <label className="flex flex-col gap-1 text-sm">Which records it can see
              <Select name="recordScope" defaultValue={resourceControls?.recordIds == null ? "all" : "chosen"}>
                <option value="all">All my records, including new ones</option>
                <option value="chosen">Only records I tick, plus ones it creates</option>
              </Select>
            </label>
            {recordChoices?.map(record => <Toggle key={record.id} name={`record:${record.id}`} on={record.granted} label={record.name} description={record.description} />)}
          </div>
        </>
      ) : null}

      {show("memory") ? (
        <>
          {/* Shared memory and sharing what it learns. */}
          <div className="wh-permission-group flex flex-col gap-3">
            <SectionHeading>Memory and sharing</SectionHeading>
            <p className="text-sm text-fg-muted">
              By default {agentName} reads shared memories and the ones it saved.
              Turn individual memories on or off below; reading must also be on.
            </p>
            <Toggle
              name="memoryRead"
              on={sharedMemoryRead}
              label="Read shared memory and its own memories"
              description={CONNECTION_CAPABILITIES.memoryRead.description}
            />
            <div className="flex flex-col gap-2">
              {memories.map((memory) => (
                <Toggle
                  key={memory.id}
                  name={`memory:${memory.id}`}
                  on={memory.granted}
                  label={memory.name}
                />
              ))}
            </div>
            <Toggle
              name="memoryWrite"
              on={memoryWrite}
              label="Save memories"
              description={CONNECTION_CAPABILITIES.memoryWrite.description}
            />
            <Toggle
              name="learningSharing"
              on={learningSharing}
              label="Share what it learns with your other agents"
              description={CONNECTION_CAPABILITIES.learningSharing.description}
            />
          </div>
        </>
      ) : null}

      {show("rules") ? (
        <div className="wh-permission-group">
          <AgentRules agentName={agentName} rules={rules} />
        </div>
      ) : null}

      {show("settings") ? (
        <>
          {/* Advanced: the per-minute request limit (default 120/min). */}
          <details className="wh-permission-group group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-fg [&::-webkit-details-marker]:hidden">
              Advanced
              <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
            </summary>
            <div className="pt-3">
              <Field
                name="requestLimit"
                label="Maximum requests per minute"
                width="code"
                type="number"
                min={1}
                max={10000}
                inputMode="numeric"
                defaultValue={limit}
              />
            </div>
          </details>
        </>
      ) : null}

      {section !== "rules" && readOnly ? (
        // A disconnected agent: nothing here can be saved, and the bar says why.
        <ActionBar note="This agent is disconnected, so its access can’t be changed. Connecting it again adds it as a new agent, with its own settings.">
          <ButtonLink href="/agents/connect" size="sm">Connect it again</ButtonLink>
        </ActionBar>
      ) : section !== "rules" ? (
        // Save — disabled with a stated reason when card access has no budget. One bounded
        // bar closes the section's panels (containment-35).
        <ActionBar
          note={
            cardNeedsBudget ? (
              <span className="inline-flex items-center gap-2 font-medium text-warning">
                <TriangleAlert aria-hidden={true} className="h-4 w-4 shrink-0" />
                Add a budget before you can save card access.
              </span>
            ) : undefined
          }
        >
          <Button
            type="button"
            variant="primary"
            disabled={cardNeedsBudget || saving}
            data-action="save"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </ActionBar>
      ) : null}
    </section>
  );
}

// The rules that apply to this agent, in two groups: the global rules it inherits (they
// apply to every agent and an individual setting cannot override a global denial) and the
// rules just for it. Each reads back as its exact sentence with its kind as a word. The
// agent's own group always shows, and its empty message says whether global rules still
// apply; the inherited group shows only when there is something to inherit.
function AgentRules({ agentName, rules }: { agentName: string; rules: ReadonlyArray<Rule> }) {
  const inherited = rules.filter((rule) => rule.scope.type === "any_agent");
  const own = rules.filter((rule) => rule.scope.type === "agent");
  const row = (rule: Rule, i: number) => (
    <li key={i} className={LIST_ROW}>
      <span className="text-sm text-fg">{ruleSentence(rule)}</span>
      <RuleKindBadge kind={rule.kind} />
    </li>
  );
  const stillApplies =
    inherited.length === 0
      ? "No rules for all agents apply either."
      : inherited.length === 1
        ? "The rule for all agents above still applies."
        : `The ${inherited.length} rules for all agents above still apply.`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <SectionHeading>Rules for {agentName}</SectionHeading>
        <p className="text-sm text-fg-muted">
          Rules for all agents apply to {agentName} too, and its own settings
          can&rsquo;t override them.{" "}
          <a href="/rules" className="text-accent underline">
            Manage rules
          </a>
        </p>
      </div>
      {inherited.length > 0 ? (
        <ListGroup
          id="agent-rules-inherited"
          level={3}
          title="Rules for all agents"
          count={inherited.length}
          summary="Set on the Rules page."
        >
          {inherited.map(row)}
        </ListGroup>
      ) : null}
      <ListGroup
        id="agent-rules-own"
        level={3}
        title={`Just for ${agentName}`}
        count={own.length}
        summary={
          own.length === 0 ? (
            <>
              No rules just for {agentName} yet. {stillApplies}{" "}
              <a
                href="/rules?view=new"
                className="font-medium text-accent underline underline-offset-2"
              >
                Add one in Rules
              </a>
              .
            </>
          ) : undefined
        }
      >
        {own.map(row)}
      </ListGroup>
    </div>
  );
}

export default PermissionsView;
