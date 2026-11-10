import type { PermissionsSection } from "@/domain/permissions/workspace";
import { Select } from "@/components/ui/select";
import * as React from "react";
import { CreditCard, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { DEFAULT_CARD_BUDGET, budgetAllowsCard, type Budget } from "@/domain/budget/budget";
import { ruleSentence, type Rule } from "@/domain/rules/rules";

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
  policy?: {readTools?:boolean; changeTools?:"off"|"allow"|"ask_first"};
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

export type PermissionsViewProps = {
  // the agent being shaped, named on the screen.
  agentName: string;
  section?: PermissionsSection;
  readTools?: boolean;
  changeTools?: "off" | "allow" | "ask_first";
  memoryWrite?: boolean;
  identityFields?: readonly string[] | null;
  vaultFields?: ReadonlyArray<SkillGrant & {tier:"low"|"high"}>;
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
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
      </span>
    </label>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-fg">{children}</h2>;
}

export function PermissionsView({
  agentName,
  section = "all", readTools = true, changeTools = "ask_first", memoryWrite = false, embedded = false, saving = false,
  connectors,
  lowTierRead,
  highTierRequest,
  identityFields = null, vaultFields = [], memories = [],
  cardAccess,
  budget,
  skills,
  tasksAccess,
  recordsAccess,
  sharedMemoryRead,
  learningSharing,
  rules,
  requestLimit,
  currency = "A$",
}: PermissionsViewProps) {
  const [vaultScope,setVaultScope]=React.useState(identityFields===null?"all":"chosen");
  // Card access cannot be switched on without a budget (and that budget must allow
  // it): the save control is disabled with a stated reason until one is set.
  const cardNeedsBudget = cardAccess && (budget === null || !budgetAllowsCard(budget));
  const budgetPeriod = budget?.period ?? DEFAULT_CARD_BUDGET.period;
  const limit = requestLimit ?? DEFAULT_REQUEST_LIMIT;

  const show = (part: PermissionsSection) => section === "all" || section === part;
  return (
    <section className="flex flex-col gap-6">
      {!embedded ? <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">What {agentName} can do</h1>
        <p className="text-sm text-fg-muted">
          Shape {agentName}&rsquo;s reach. Changes take effect on its next request.
        </p>
      </header> : null}

      {show("connectors") ? <>
      {/* Connected services and their tools — reads and changes listed separately. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Connected services</SectionHeading>
        <p className="text-sm text-fg-muted">Service accounts belong to you. Choose which services this agent may use. Connecting a service does not grant agent access.</p>
        <Toggle name="readTools" on={readTools} label="Allow reading from granted services" />
        <label className="flex flex-col gap-2 text-sm font-medium">Changes to granted services
          <Select name="changeTools" defaultValue={changeTools}>
            <option value="off">Off</option><option value="ask_first">Ask me first</option><option value="allow">Allow, subject to rules</option>
          </Select>
        </label>
        {connectors.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No services connected yet.{" "}
            <a href="/connectors" className="font-medium text-accent underline underline-offset-2">
              Connect one
            </a>{" "}
            to let {agentName} use it.
          </p>
        ) : null}
        {connectors.map((connector) => (
          <Card key={connector.id} className="flex flex-col gap-3">
            {connector.granted === undefined ? (
              <h3 className="font-medium text-fg">{connector.name}</h3>
            ) : (
              <Toggle
                name={`connector:${connector.id}`}
                on={connector.granted}
                label={`Let it use ${connector.name}`}
                description="Access follows the reading and changes settings above, plus your global and agent rules."
              />
            )}

            {connector.accounts?.length ? <label className="flex flex-col gap-2 text-sm font-medium">{connector.name} account for this agent
              <Select name={`connectorAccount:${connector.id}`} defaultValue={connector.accountId ?? ""}>
                <option value="">Choose an account</option>{connector.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
              </Select>
              <span className="text-xs font-normal text-fg-muted">When more than one account is connected, this agent must have an account selected before it can use the service.</span>
            </label> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">Read tools
                <Select name={`connectorPolicyRead:${connector.id}`} defaultValue={connector.policy?.readTools === undefined ? "default" : connector.policy.readTools ? "on" : "off"}>
                  <option value="default">Use agent default</option><option value="on">Allow reads</option><option value="off">Off</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-sm">Change tools
                <Select name={`connectorPolicyChange:${connector.id}`} defaultValue={connector.policy?.changeTools ?? "default"}>
                  <option value="default">Use agent default</option><option value="off">Off</option><option value="ask_first">Ask me first</option><option value="allow">Allow, subject to rules</option>
                </Select>
              </label>
            </div>
            <p className="text-sm text-fg-muted">Provider-hosted tools still require approval until their effects are verified.</p>
            {connector.readTools.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <h4 className="text-sm font-medium text-fg-muted">Reads</h4>
                <ul className="flex flex-col gap-1">
                  {connector.readTools.map((tool) => (
                    <li
                      key={tool}
                      className="rounded-card border border-line bg-surface-muted p-2 text-sm text-fg"
                    >
                      {tool}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {connector.changeTools.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <h4 className="text-sm font-medium text-fg-muted">Makes changes</h4>
                <ul className="flex flex-col gap-1">
                  {connector.changeTools.map((tool) => (
                    <li
                      key={tool}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface-muted p-2 text-sm text-fg"
                    >
                      <span>{tool}</span>
                      <span className="font-medium text-fg-muted">{changeTools === "off" ? "Off" : changeTools === "allow" ? "Allowed, subject to rules" : "Ask me first"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        ))}
      </div>

      </> : null}

      {show("vault") ? <>
      {/* Identity: low-tier read vs. the high-tier REQUEST toggle. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Your identity</SectionHeading>
        <label className="flex flex-col gap-1 text-sm">Vault fields
          <Select name="identityScope" value={vaultScope} onChange={event=>setVaultScope(event.target.value)}>
            <option value="all">All fields, including future fields</option><option value="chosen">Only chosen fields</option>
          </Select>
        </label>
        {vaultScope === "chosen" && <div className="flex flex-col gap-2">{vaultFields.map(field=><Toggle key={field.id} name={`vaultField:${field.id}`} on={field.granted} label={field.name} description={field.tier === "high" ? "Sensitive · always asks first" : "Everyday detail"}/>)}</div>}

        <p className="text-sm text-fg-muted">Your vault is shared storage owned by you. These controls apply only to this agent. Sensitive details always need your approval. <a href="/vault" className="text-accent underline">Manage vault contents</a></p>
        <Toggle
          name="identity"
          on={lowTierRead}
          label="Read your low-tier identity details"
          description="Low tier only — the everyday basics, never the sensitive ones."
        />
        <Toggle
          name="highTier"
          on={highTierRequest}
          label="Let it ask for high-tier identity details"
          description="You approve each request before anything is released."
        />
      </div>

      </> : null}

      {show("spending") ? <>
      {/* Card access and its spending budget. The budget field shows only alongside
          card access; enabling card access without a budget blocks save. */}
      <div className="flex flex-col gap-3">
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
              label={`Budget per ${budgetPeriod} (${currency})`}
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              defaultValue={budget ? budget.amount : undefined}
              placeholder={String(DEFAULT_CARD_BUDGET.amount)}
            />
            <Field name="cardBudgetCurrency" label="Budget currency (three-letter code)" defaultValue={currency} maxLength={3} />
            <label className="flex flex-col gap-2 text-sm font-medium">Budget period
              <Select name="cardBudgetPeriod" defaultValue={budgetPeriod}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></Select>
            </label>
            <p className="text-sm text-fg-muted">
              Defaults to {currency}
              {DEFAULT_CARD_BUDGET.amount} per {DEFAULT_CARD_BUDGET.period}.
            </p>
          </Card>
        ) : null}
      </div>

      </> : null}

      {show("skills") ? <>
      {/* Skills it receives. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Skills</SectionHeading>
        <p className="text-sm text-fg-muted">Choose skills for this agent. Your choices override each skill’s shared or chosen-agent default; disabled skills remain unavailable. Warthog’s house instructions always apply.</p>
        {skills.length === 0 ? <p className="text-sm text-fg-muted">No enabled personal skills yet.</p> : null}
        <a href="/skills" className="text-sm text-accent underline">Manage the shared skills library</a>
        {skills.map((skill) => (
          <Toggle key={skill.id} name={`skill:${skill.id}`} on={skill.granted} label={skill.name} />
        ))}
      </div>

      </> : null}

      {show("settings") ? <>
      {/* The person's tasks and life-admin records — their own grants. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Tasks and records</SectionHeading>
        <Toggle
          name="tasks"
          on={tasksAccess}
          label="Your tasks"
          description="See, add and update your tasks."
        />
        <Toggle
          name="records"
          on={recordsAccess}
          label="Your life-admin records"
          description="Subscriptions, receipts and warranties, renewals and appointments."
        />
      </div>

      </> : null}

      {show("memory") ? <>
      {/* Shared memory and sharing what it learns. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Memory and sharing</SectionHeading>
        <p className="text-sm text-fg-muted">Shared and source-agent memory are the defaults. Choose individual memories below to override access for this agent; reading must also be on.</p>
        <Toggle name="memoryRead" on={sharedMemoryRead} label="Read shared memory and its own memories" />
        <div className="flex flex-col gap-2">{memories.map(memory=><Toggle key={memory.id} name={`memory:${memory.id}`} on={memory.granted} label={memory.name}/>)}</div>
        <Toggle name="memoryWrite" on={memoryWrite} label="Save memories" description="Allow this agent to add memories independently of reading them." />
        <Toggle
          name="learningSharing"
          on={learningSharing}
          label="Share what it learns with your other agents"
        />
      </div>

      </> : null}

      {show("rules") ? <>
      {/* The agent's own rules, each read back as its exact plain-English sentence. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Rules for {agentName}</SectionHeading>
        <p className="text-sm text-fg-muted">Global rules apply to every agent. Individual settings cannot override a global denial. <a href="/rules" className="text-accent underline">Manage global and agent rules</a></p>
        {rules.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No rules just for {agentName} yet.{" "}
            <a href="/rules" className="font-medium text-accent underline underline-offset-2">
              Add one in Rules
            </a>
            .
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {rules.map((rule, i) => (
            <li
              key={i}
              className="rounded-card border border-line bg-surface p-3 text-sm text-fg"
            >
              {ruleSentence(rule)}
            </li>
          ))}
        </ul>
      </div>

      </> : null}

      {show("settings") ? <>
      {/* Advanced: the per-minute request limit (default 120/min). */}
      <details className="rounded-card border border-line bg-surface p-3">
        <summary className="cursor-pointer text-sm font-semibold text-fg">Advanced</summary>
        <div className="mt-3">
          <Field
            name="requestLimit"
            label="Request limit (per minute)"
            type="number"
            min={1}
            max={10000}
            inputMode="numeric"
            defaultValue={limit}
          />
        </div>
      </details>

      </> : null}

      {section !== "rules" ? <>
      {/* Save — disabled with a stated reason when card access has no budget. */}
      <div className="flex flex-col gap-2">
        {cardNeedsBudget ? (
          <p className="inline-flex items-center gap-2 text-sm font-medium text-warning">
            <TriangleAlert aria-hidden={true} className="h-4 w-4 shrink-0" />
            Add a budget before you can save card access.
          </p>
        ) : null}
        <Button type="button" variant="primary" disabled={cardNeedsBudget || saving} data-action="save">
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
      </> : null}
    </section>
  );
}

export default PermissionsView;
