import * as React from "react";
import { AgentMark } from "@/components/ui/brand-mark";
import { Activity, AlertTriangle, ArrowRight, Brain, ChevronDown, ChevronLeft, Gauge, Lock, Network, Plug, Settings, SlidersHorizontal, Sparkles, Wallet, type LucideIcon } from "lucide-react";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { type AgentSection } from "@/domain/permissions/workspace";
import type { AgentWorkspaceData } from "@/server/agents/workspace-data";
import type { PermissionsViewProps } from "./permissions-view";
import { agentNavigation } from "@/components/shell/workspace-navigation";
import { NavigationTabs } from "@/components/shell/section-navigation";
import { Notice } from "@/components/ui/notice";
import { Status } from "@/components/ui/status";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import { LIST_ROW } from "@/components/ui/list-group";
import { formatMoney } from "@/domain/approvals/request-sentence";
import { platformLabel } from "./platform-label";
import { AgentAuditLog } from "./agent-audit-log";

// The agent workspace (/agents/[id]): the heading band every section shares, the Overview,
// and the read-outs that sit above a section's permission controls (memory, activity,
// spending). Every piece of text lives in a bounded surface — the heading band, a panel,
// a list group or a notice — never loose on the canvas (founder rule 1). Pure: the page
// loads and formats everything; the view reaches for no clock or database.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// How many entries of an agent's record need a look: blocked, failed or disputed.
function attentionCount(summary: AgentWorkspaceData["auditSummary"]): number {
  return summary ? summary.byOutcome.blocked + summary.byOutcome.failed + summary.disputed : 0;
}

const BACK_LINK = "min-h-11 items-center gap-1 self-start text-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline lg:min-h-8";

export function AgentWorkspaceHeader({
  data,
  section,
}: {
  data: AgentWorkspaceData;
  section: AgentSection;
}) {
  const connected = data.agent.status === "connected";
  const platform = platformLabel(data.agent.platform);
  const navigation = agentNavigation(data.agent.id, section);
  return (
    <header className="wh-surface wh-agent-heading flex flex-col gap-3">
      {/* "All agents": its own row only on a phone, where the name needs the width; from
          640px (including a landscape phone) it sits at the end of the name row, so the band
          doesn't spend a row on it (mobile-03). Only one of the two is ever displayed. */}
      <a href="/agents" className={`${BACK_LINK} inline-flex sm:hidden`}>
        <ChevronLeft aria-hidden className="h-4 w-4 shrink-0" />
        All agents
      </a>
      <div>
        <AgentMark platform={data.agent.platform} name={data.agent.displayName} size="lg" />
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <h1>{data.agent.displayName}</h1>
          {/* The state with its icon and colour (as <Status> shows it everywhere), then the
              platform in words and the request count as plain meta. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted sm:gap-x-2">
            <Status status={connected ? "connected" : "needs-reconnect"} />
            {platform ? <><span aria-hidden className="hidden sm:inline">·</span><span>{platform}</span></> : null}
            <span aria-hidden className="hidden sm:inline">·</span>
            <span>{plural(data.agent.requestCount, "request", "requests")}</span>
          </p>
        </div>
        <a href="/agents" className={`${BACK_LINK} hidden shrink-0 sm:inline-flex`}>
          <ChevronLeft aria-hidden className="h-4 w-4 shrink-0" />
          All agents
        </a>
      </div>
      <div>
        <NavigationTabs label="Manage this agent" items={navigation.primary} />
        {navigation.secondary.length > 0 && (
          <NavigationTabs label="Agent section" items={navigation.secondary} secondary />
        )}
      </div>
      {!connected ? (
        // A disconnected agent is a dead end without the way back (interaction-08): say what
        // it means here, and offer the one route there is — connecting it from the start.
        <Notice tone="info" announce={false}>
          <div className="flex flex-col items-start gap-3">
            <p>
              This agent is disconnected, so it can&rsquo;t use anything in Warthog. Its
              settings are shown read-only, and its history stays in Activity.
            </p>
            <ButtonLink href="/agents/connect" size="sm">
              Connect it again
            </ButtonLink>
          </div>
        </Notice>
      ) : null}
    </header>
  );
}

export function AgentOverview({
  data,
  permissions,
  lastActive,
}: {
  data: AgentWorkspaceData;
  permissions: PermissionsViewProps;
  // "Today, 6:17 pm" — when it last made a request, already formatted by the page.
  lastActive?: string | null;
}) {
  const name = data.agent.displayName;
  const grantedServices = permissions.connectors.filter((c) => c.granted !== false).length;
  const skills = permissions.skillCount ?? permissions.skills.filter((s) => s.granted).length;
  const attention = attentionCount(data.auditSummary);
  const tasksAndRecords =
    permissions.tasksAccess && permissions.recordsAccess
      ? "Can use your tasks and records"
      : permissions.tasksAccess
        ? "Can use your tasks"
        : permissions.recordsAccess
          ? "Can use your records"
          : "Tasks and records off";
  const cards = [
    ["connectors", "Connectors", `${plural(grantedServices, "service", "services")} allowed`],
    [
      "vault",
      "Vault",
      `${permissions.lowTierRead ? "Reads your everyday details" : "Everyday details off"}${permissions.highTierRequest ? " · can ask for protected details" : ""}`,
    ],
    ["skills", "Skills", `${plural(skills, "skill", "skills")} available`],
    [
      "memory",
      "Memory",
      `Reading ${permissions.sharedMemoryRead ? "on" : "off"} · saving ${permissions.memoryWrite ? "on" : "off"}`,
    ],
    [
      "spending",
      "Spending",
      permissions.cardAccess ? "Can ask to use a card; you approve each one" : "Card requests off",
    ],
    ["rules", "Rules", plural(permissions.rules.length, "rule applies", "rules apply")],
    [
      "activity",
      "Activity",
      data.auditSummary
        ? `${plural(data.auditSummary.total, "entry", "entries")} · ${attention === 0 ? "nothing needs attention" : `${attention} ${attention === 1 ? "needs" : "need"} attention`}`
        : `What ${name} did through Warthog`,
    ],
    ["settings", "Settings", tasksAndRecords],
  ] as const;
  const icons = {
    connectors: Plug,
    vault: Lock,
    skills: Sparkles,
    memory: Brain,
    spending: Wallet,
    rules: SlidersHorizontal,
    activity: Activity,
    settings: Settings,
  } satisfies Record<(typeof cards)[number][0], LucideIcon>;
  const branches = [
    { title: "Resources", items: cards.slice(0, 4) },
    { title: "Controls & history", items: [cards[4], cards[5], cards[7], cards[6]] },
  ];
  const id = encodeURIComponent(data.agent.id);
  return (
    <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
      <section className="wh-surface wh-access-map" aria-label="This agent’s access">
        <div className="wh-access-map-intro">
          <span className="wh-object-icon"><Network aria-hidden size={18} strokeWidth={1.7} /></span>
          <div>
            <h2>This agent’s access</h2>
            <p>Your account owns these resources. These settings decide what {name} can use through Warthog, and your rules for all agents still apply.</p>
          </div>
        </div>
        <div className="wh-access-branches">
          {branches.map((branch) => (
            <section className="wh-access-branch" key={branch.title} aria-label={branch.title}>
              <h3>{branch.title}</h3>
              {branch.items.map(([key, title, detail]) => {
                const Icon = icons[key];
                return (
                  <a key={key} href={`/agents/${data.agent.id}?section=${key}`} className="wh-access-node">
                    <Icon aria-hidden size={18} strokeWidth={1.7} />
                    <span><strong>{title}</strong><small>{detail}</small></span>
                    <ArrowRight aria-hidden size={14} />
                  </a>
                );
              })}
            </section>
          ))}
        </div>
        {/* The boundary and the account-wide controls close the access panel, rather than
            floating between panels (containment-31). */}
        <div className="mt-6 flex flex-col gap-1 border-t border-line pt-4 text-sm leading-relaxed text-fg-muted">
          <p>Warthog controls only what {name} does through Warthog, not its own tools or chats.</p>
          <p>
            For every agent, see{" "}
            <a className="font-medium text-fg underline underline-offset-4" href="/settings/agents">Agent defaults</a>{" "}
            and{" "}
            <a className="font-medium text-fg underline underline-offset-4" href="/rules">rules for all agents</a>.
          </p>
        </div>
      </section>
      <RecentRequests data={data} lastActive={lastActive ?? null} activityHref={`/agents/${id}?section=activity`} attention={attention} />
    </div>
  );
}

// "How it's going": the plain summary a member needs (when it last asked, how much it has
// asked, what went wrong), with the connection's diagnostics kept — but folded away under
// "Technical details" rather than leading the page (content-06).
function RecentRequests({
  data,
  lastActive,
  activityHref,
  attention,
}: {
  data: AgentWorkspaceData;
  lastActive: string | null;
  activityHref: string;
  attention: number;
}) {
  const name = data.agent.displayName;
  const summary = data.auditSummary;
  const performance = data.performance;
  const client = data.clientObservation;
  const id = encodeURIComponent(data.agent.id);
  const reported = client?.name ? [client.name, client.version].filter(Boolean).join(" ") : null;
  return (
    <WorkspacePanel
      title="How it’s going"
      icon={Gauge}
      description={`What ${name} has asked Warthog to do lately.`}
      action={<a href={activityHref} className="inline-flex min-h-11 items-center underline underline-offset-4 lg:min-h-0">View its activity</a>}
    >
      <div className="flex flex-col gap-4 text-sm">
        <dl className="grid gap-3 rounded-field bg-surface-muted p-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-fg-muted">Last request</dt>
            <dd className="mt-1 font-medium">{lastActive ?? "None yet"}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Requests</dt>
            <dd className="mt-1 font-medium tabular-nums">{data.agent.requestCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Blocked or failed</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {summary ? summary.byOutcome.blocked + summary.byOutcome.failed : 0}
            </dd>
          </div>
        </dl>
        {attention > 0 ? (
          <a
            href={`/activity?agent=${id}&attention=1&via=agents`}
            className="inline-flex min-h-11 items-center gap-2 self-start font-medium underline underline-offset-4"
          >
            <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-warning" />
            Review {attention === 1 ? "the entry" : `the ${attention} entries`} that need attention
          </a>
        ) : null}
        {reported ? (
          <p className="text-fg-muted">
            The app says it is {reported}. Warthog can&rsquo;t verify that.
          </p>
        ) : null}
        <details className="group border-t border-line pt-2">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium text-fg [&::-webkit-details-marker]:hidden">
            Technical details
            <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-col gap-3 pb-2 text-fg-muted">
            <p>Connected means this connection is authorised. It isn&rsquo;t a live check that the app is running.</p>
            {client ? (
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
                <dt>App</dt>
                <dd className="text-fg">{client.name ?? "Not reported"} · {client.version ?? "version not reported"}</dd>
                <dt>Protocol</dt>
                <dd className="text-fg">{client.protocol ?? "Not reported"}</dd>
                <dt>Capabilities</dt>
                <dd className="text-fg">{client.capabilities?.join(", ") || "Not reported"}</dd>
                <dt>Last seen</dt>
                <dd className="text-fg"><time dateTime={client.observedAt}>{client.displayObservedAt}</time></dd>
              </dl>
            ) : (
              <p>No details about the app have been recorded yet. Earlier history can&rsquo;t supply them.</p>
            )}
            <p>The app reports these details itself. Warthog verifies this connection&rsquo;s credential, not the person, model or conversation behind it.</p>
            <p>
              Of its latest {performance?.examined ?? 0} requests (up to 100), {performance?.measured ?? 0} have a recorded
              result: {performance?.failed ?? 0} failed, {performance?.unknown ?? 0} unknown and {performance?.refused ?? 0} refused.
              95th percentile response time:{" "}
              <span className="text-fg">{performance?.p95Ms == null ? "not available yet" : `${performance.p95Ms} ms`}</span>.
            </p>
            <p>Requests waiting for your approval, and older entries without a recorded result, aren&rsquo;t counted. A held request can have separate approval and completion entries.</p>
          </div>
        </details>
      </div>
    </WorkspacePanel>
  );
}

// The read-outs above a section's own controls: what this agent can read in memory, its
// activity, and what it has spent. Each is one panel (or list groups) — never loose text.
export function AgentResources({
  data,
  section,
}: {
  data: AgentWorkspaceData;
  section: AgentSection;
}) {
  const name = data.agent.displayName;
  const connected = data.agent.status === "connected";
  if (section === "memory")
    return (
      <WorkspacePanel
        title="Memories this agent can read"
        description="The latest 50 it can read."
        action={<a href="/memory" className="inline-flex min-h-11 items-center underline underline-offset-4 lg:min-h-0">Manage memories</a>}
      >
        {data.memory.length ? (
          <ul role="list" className="-my-3 flex flex-col">
            {data.memory.map((item) => (
              <li key={item.id} className={LIST_ROW}>
                <p className="whitespace-pre-wrap text-sm text-fg [overflow-wrap:anywhere]">{item.content}</p>
                <p className="text-xs text-fg-muted">
                  {item.scope === "shared"
                    ? "Shared with your agents"
                    : item.own
                      ? "Private to this agent"
                      : "Private · this agent has access"}{" "}
                  · {item.own ? "Saved by this agent" : "Saved by you or another agent"} · {item.savedAt}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            variant="inline"
            icon={Brain}
            heading={
              !connected
                ? "This agent is disconnected, so it can’t read memories."
                : data.memoryRead
                  ? "No memories it can read yet."
                  : "Memory reading is off for this agent."
            }
            description={
              !connected
                ? undefined
                : data.memoryRead
                  ? `Memories you share with your agents, and ones ${name} saves, appear here.`
                  : "Turn on reading below to let it use your shared memories."
            }
          />
        )}
      </WorkspacePanel>
    );
  // The Activity section is its own component (lane B's AgentAuditLog: summary panel, then
  // one list-group panel per day), rendered here inside the workspace.
  if (section === "activity") return <AgentAuditLog data={data} />;
  if (section === "spending")
    return (
      <WorkspacePanel
        title="Approved card releases"
        description="Amounts you approved for this agent, not confirmed charges."
        footer={
          <>
            <a
              href={`/activity?agent=${encodeURIComponent(data.agent.id)}&type=approval&via=agents`}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              View its card release history
            </a>
            <a href="/vault/cards" className="inline-flex min-h-11 items-center underline underline-offset-4">
              Manage your cards
            </a>
          </>
        }
      >
        {data.budget && data.spending ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <span className="font-semibold tabular-nums">{formatMoney(data.spending.total, data.budget.currency)}</span> of{" "}
              {formatMoney(data.budget.amount, data.budget.currency)} approved this {data.budget.period}
            </p>
            {data.spending.unconverted.length ? (
              <Notice tone="warning" announce={false}>
                The total is incomplete:{" "}
                {data.spending.unconverted
                  .map((item) => `${item.currency} ${item.amount}`)
                  .join(", ")}{" "}
                could not be converted.
              </Notice>
            ) : null}
          </div>
        ) : (
          <EmptyState
            variant="inline"
            icon={Wallet}
            heading="No card budget set for this agent."
            description={connected ? "Turn on card access below and set a card budget to let it ask to use a card." : undefined}
          />
        )}
      </WorkspacePanel>
    );
  return null;
}
