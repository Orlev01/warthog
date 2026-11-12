import * as React from "react";
import { Activity, ArrowRight, Bot, Brain, Gauge, Lock, Network, Plug, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Wallet, type LucideIcon } from "lucide-react";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { type AgentSection } from "@/domain/permissions/workspace";
import type { AgentWorkspaceData } from "@/server/agents/workspace-data";
import type { PermissionsViewProps } from "./permissions-view";
import { agentNavigation } from "@/components/shell/workspace-navigation";
import { NavigationTabs } from "@/components/shell/section-navigation";
import { Notice } from "@/components/ui/notice";

export function AgentWorkspaceHeader({
  data,
  section,
}: {
  data: AgentWorkspaceData;
  section: AgentSection;
}) {
  return (
    <header className="wh-surface wh-agent-heading flex flex-col gap-3">
      <a href="/agents" className="inline-flex min-h-11 items-center self-start text-xs text-fg-muted underline underline-offset-4">
        All agents
      </a>
      <div>
        <span className="wh-object-icon"><Bot aria-hidden size={24} strokeWidth={1.5} /></span>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.agent.displayName}
          </h1>
          <p className="text-sm text-fg-muted">
            {data.agent.platform} ·{" "}
            {data.agent.status === "connected" ? "Connected" : "Disconnected"} ·{" "}
            {data.agent.requestCount} requests
          </p>
        </div>
      </div>
      <div>
        <NavigationTabs
          label="Manage this agent"
          items={agentNavigation(data.agent.id, section).primary}
        />
        {agentNavigation(data.agent.id, section).secondary.length > 0 && (
          <NavigationTabs
            label="Agent section"
            items={agentNavigation(data.agent.id, section).secondary}
            secondary
          />
        )}
      </div>
      {data.agent.status !== "connected" ? (
        <Notice tone="info" announce={false}>
          This agent is disconnected and cannot use your resources. Its history
          remains available.
        </Notice>
      ) : null}
    </header>
  );
}

export function AgentOverview({
  data,
  permissions,
}: {
  data: AgentWorkspaceData;
  permissions: PermissionsViewProps;
}) {
  const cards = [
    [
      "connectors",
      "Connectors",
      `${permissions.connectors.filter((c) => c.granted).length} services granted`,
    ],
    [
      "vault",
      "Vault",
      permissions.lowTierRead
        ? "Can read everyday identity details"
        : "Everyday identity access off",
    ],
    [
      "skills",
      "Skills",
      `${permissions.skillCount ?? permissions.skills.filter((s) => s.granted).length} personal skills available`,
    ],
    [
      "memory",
      "Memory",
      `Reading ${permissions.sharedMemoryRead ? "on" : "off"} · saving ${permissions.memoryWrite ? "on" : "off"}`,
    ],
    [
      "spending",
      "Spending",
      permissions.cardAccess
        ? "Card requests enabled; approval required"
        : "Card requests off",
    ],
    [
      "rules",
      "Rules",
      `${permissions.rules.length} active global and agent rules`,
    ],
    [
      "activity",
      "Audit log",
      "Actions observed by Warthog and labelled agent reports",
    ],
    [
      "settings",
      "Settings",
      `${permissions.requestLimit} requests per minute · tasks and records`,
    ],
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
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="wh-surface wh-access-map" aria-label="This agent’s access">
        <div className="wh-access-map-intro">
          <span className="wh-object-icon"><Network aria-hidden size={20} /></span>
          <div>
            <h2>This agent’s access</h2>
            <p>Your account owns the resources. This workspace controls what {data.agent.displayName} can use through Warthog. Global rules still apply.</p>
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
      </section>
      <div className="wh-evidence-grid">
        <WorkspacePanel title="Connection evidence" icon={ShieldCheck} description="What Warthog can verify">
          <p>Connected means access is authorised. It is not a live heartbeat.</p>
          {data.clientObservation ? <>
            <p>Client reported: {data.clientObservation.name ?? "Name unavailable"} · {data.clientObservation.version ?? "Version unavailable"}</p>
            <p>Protocol: {data.clientObservation.protocol ?? "Unavailable"} · Capabilities: {data.clientObservation.capabilities?.join(", ") || "Not reported"}</p>
            <p>Last observed: <time dateTime={data.clientObservation.observedAt}>{data.clientObservation.displayObservedAt}</time></p>
          </> : <p className="text-fg-muted">No client metadata has been recorded yet. Existing history cannot supply it.</p>}
          <p className="text-fg-muted">Client metadata is self-reported. Warthog verifies this connection’s credential, not the client’s human, model or conversation identity.</p>
        </WorkspacePanel>
        <WorkspacePanel title="Recent request performance" icon={Gauge} description="Evidence from this connection">
          <p>{data.performance?.measured ?? 0} measured outcomes among the latest {data.performance?.examined ?? 0} call records (up to 100).</p>
          <dl className="wh-evidence-facts">
            <div><dt>Failed</dt><dd>{data.performance?.failed ?? 0}</dd></div>
            <div><dt>Unknown</dt><dd>{data.performance?.unknown ?? 0}</dd></div>
            <div><dt>Refused</dt><dd>{data.performance?.refused ?? 0}</dd></div>
          </dl>
          <p>95th percentile response time: <strong className="font-medium">{data.performance?.p95Ms == null ? "Not available yet" : `${data.performance.p95Ms} ms`}</strong></p>
          <p className="text-fg-muted">Pending approvals and older entries without result evidence are excluded. A held request can have separate approval and completion records.</p>
        </WorkspacePanel>
      </div>
      <p className="text-sm text-fg-muted">
        Manage <a className="text-accent underline" href="/settings/agents">defaults for new agents</a> or <a className="text-accent underline" href="/rules">global rules</a> for the whole account.
      </p>
      <Notice tone="info" announce={false}>
        Warthog governs actions routed through its connection. It cannot control
        tools an agent uses directly elsewhere. An external platform must
        support a compatible connection to use Warthog.
      </Notice>
    </div>
  );
}

export function AgentResources({
  data,
  section,
}: {
  data: AgentWorkspaceData;
  section: AgentSection;
}) {
  if (section === "memory")
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Memories this agent can read</h2>
        <p className="text-sm text-fg-muted">
          The latest 50 readable memories.{" "}
          <a href="/memory" className="text-accent underline">
            Manage all memories and their sharing
          </a>
        </p>
        {data.memory.length ? (
          <ul className="flex flex-col gap-3">
            {data.memory.map((item) => (
              <li
                key={item.id}
                className="wh-card rounded-card border border-line bg-surface p-4"
              >
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {item.content}
                </p>
                <p className="mt-2 text-xs text-fg-muted">
                  {item.scope === "shared"
                    ? "Shared with permitted agents"
                    : "Available to this agent"}{" "}
                  ·{" "}
                  {item.own
                    ? "Saved by this agent"
                    : "Saved by you or another agent"}{" "}
                  · {item.savedAt}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            {data.memoryRead
              ? "No readable memories yet."
              : "Memory reading is off for this agent."}
          </p>
        )}
      </section>
    );
  if (section === "activity")
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">This agent’s audit log</h2>
        <p className="text-sm text-fg-muted">
          The latest 50 entries for this agent.{" "}
          <a
            href={`/activity?agent=${data.agent.id}`}
            className="text-accent underline"
          >
            Open the full filtered log
          </a>{" "}
          or{" "}
          <a href="/activity" className="text-accent underline">
            view all agents
          </a>
          .
        </p>
        {data.activity.length ? (
          <ol className="flex flex-col gap-3">
            {data.activity.map((entry) => (
              <li
                key={entry.seq}
                className="wh-card rounded-card border border-line bg-surface p-4"
              >
                <a
                  href={`/activity?agent=${data.agent.id}&entry=${entry.seq}#entry-${entry.seq}`}
                  className="font-medium text-accent underline"
                >
                  {entry.title}
                </a>
                <p className="text-sm text-fg-muted">
                  {entry.outcome} · {entry.at}
                </p>
                <p className="text-sm [overflow-wrap:anywhere]">{entry.summary}
                </p>
                {entry.reported ? (
                  <p className="text-sm text-fg-muted">
                    Reported by {data.agent.displayName}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-fg-muted">
            No activity recorded for this agent yet.
          </p>
        )}
      </section>
    );
  if (section === "spending")
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Approved card releases</h2>
        {data.budget && data.spending ? (
          <>
            <p>
              {data.budget.currency} {data.spending.total.toFixed(2)} of{" "}
              {data.budget.currency} {data.budget.amount.toFixed(2)} this{" "}
              {data.budget.period}
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
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            No spending budget set for this agent.
          </p>
        )}
        <p className="text-sm text-fg-muted">
          Approved releases are amounts authorised, not confirmed charges.{" "}
          <a
            href={`/activity?agent=${data.agent.id}&kind=card_release`}
            className="text-accent underline"
          >
            View this agent’s card release history
          </a>
          .{" "}
          <a href="/vault/cards" className="text-accent underline">
            Manage your cards
          </a>
          .
        </p>
      </section>
    );
  return null;
}
