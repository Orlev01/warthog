import * as React from "react";
import { ServiceMark } from "@/components/ui/brand-mark";
import { toolLabel } from "@/domain/activity/describe";
import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";

import { ViewPanels } from "@/components/ui/view-tabs";
import { Status, type StatusKey } from "@/components/ui/status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { FilterLinks } from "@/components/ui/filter-links";
import { hrefWith, type QueryState } from "@/lib/href";

// E09-S16 — Connectors view component (src/components/connectors/connectors-view.tsx).
//
// The Connectors screen is a primary-journey surface (brief "Connector hub"; design §7;
// CLAUDE.md vocabulary — a *connector* is a catalogue entry, a *connection* is a person's
// connected service). It has two halves:
//   • the CATALOGUE — searchable and browsable BY CATEGORY, with a Connect control on each
//     entry, the "Early access — ask to join" funnel on a gated Google entry, and a
//     "Request a connector" affordance on a miss (nothing matched the search); and
//   • the CONNECTED-SERVICES list — each connection showing its status, the account
//     connected, the connected date, the tools it offers (each marked "reads" or "makes
//     changes"), which agents may use it, and a one-click Disconnect.
//
// This is the PURE, prop-driven VIEW — exactly like AgentListView / DashboardView /
// ActivityView: it renders the screen from already-formatted props so it can be pinned
// without a browser, a session or any server plumbing. The loader (a later task)
// reads/decrypts/formats and feeds it: dates arrive as pre-formatted LABELS, the per-person
// Google gate decision arrives as each catalogue item's `gate`, connection `status` is the
// shared StatusKey union the <Status> primitive renders, and the Connect / Disconnect /
// Request controls are BOUND to the server actions the page passes (exactly as
// AgentListView binds Disconnect). The view reaches for no clock, locale, DB or config.
//
// Colour comes from the design tokens (globals.css), never a raw hex.
//
// Organisation: the catalogue is filtered by category with same-page links (All first,
// each with its count of matches for the current search) that keep the search text; an
// entry the person already connected carries a "Connected" badge in words and an icon.
// Connected cards summarise their tools ("n tools · n make changes") with the full list
// (each tool still marked "Reads" or "Makes changes") behind a "Show tools" disclosure.
// Disconnect stays one click (brief: "disconnect in one click").

// One catalogue entry as the view renders it. `connectable` is the index's own
// connectability truth (E09-S15). `gate` is the per-person decision (E09-S13): "connect"
// offers a Connect control; "ask_to_join" is a gated Google entry — the view shows the
// "Early access — ask to join" funnel instead of Connect.
export type CatalogueItem = {
  verification?: string;
  id: string;
  name: string;
  connectable: boolean;
  unavailableReason?: string;
  gate: "connect" | "ask_to_join";
  // The person already has at least one account of this service connected.
  connected?: boolean;
};

// The catalogue entries of one category, grouped so the view renders a section per
// category (brief "searchable and browsable by category").
export type CatalogueGroup = {
  category: string;
  items: readonly CatalogueItem[];
};

// One tool a connection offers, marked: false = a read, true = makes a change (brief
// 'each marked as "reads" or "makes changes"').
export type ToolItem = {
  name: string;
  makesChange: boolean;
};

// One of the person's connected services as the view lists it (never credentials):
// the connector display name, the account connected, the pre-formatted connected-date
// label, the status, the marked tools, and the names of the agents that may use it.
export type ConnectionItem = {
  id: string;
  // The catalogue entry this connection is an account of (identifies its brand mark).
  connectorId?: string;
  name: string;
  accountLabel: string;
  unavailableReason?: string;
  reconnectable?: boolean;
  status: StatusKey;
  connectedAt: string;
  tools: readonly ToolItem[];
  agents: readonly string[];
};

// One catalogue category the filter links offer, with how many entries it holds that
// match the current search.
export type CategoryCount = {
  key: string;
  count: number;
};

export type ConnectorsViewProps = {
  initialView?: string;
  groups: readonly CatalogueGroup[];
  // Every category to filter by (validated by the loader), and the one chosen (null = all).
  categories?: readonly CategoryCount[];
  category?: string | null;
  connections: readonly ConnectionItem[];
  query: string | null; // the search term echoed back (prefill); null = no search
  canRequest: boolean; // a MISS → surface "Request a connector"
  // Controls BOUND to server actions the page passes. OPTIONAL: when an action is NOT
  // supplied its control renders DISABLED with a one-line reason rather than a live button
  // over a missing action (constitution: no dead controls — disable it and say why),
  // exactly as AgentListView treats its Disconnect action.
  connectAction?: (formData: FormData) => void | Promise<void>;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
  reconnectAction?: (formData: FormData) => void | Promise<void>;
  requestAction?: (formData: FormData) => void | Promise<void>;
};

// E09-S13's ASK_TO_JOIN funnel copy and the miss affordance copy — UI copy, do not drift
// (the "—" is an em dash, U+2014).
const EARLY_ACCESS_LABEL = "Early access — ask to join";
const REQUEST_LABEL = "Request a connector";

// Native action buttons mirror the shared Button primitive's look on the design tokens
// (≥44px target, token colour/radius/focus) but as native <button>s — the same pattern as
// AgentListView. Everything is the neutral surface variant (the accent is reserved for a
// screen's one primary action). Styled through tokens, no raw colour.
const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
// A control that is present but not actionable: the neutral surface look, dimmed and
// non-interactive, the native `disabled` attribute doing the disabling. No raw colour.
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

// A small neutral badge for a tool's "reads" / "makes changes" marking — status by WORDS,
// never by colour alone (brief design_ux.feel). Styled through tokens, no raw colour.
const MARK_BADGE =
  "rounded-card bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted";
const SUMMARY_LINK =
  "inline-flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-field text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden";

const PATH = "/connectors";

// A category slug as a person reads it: "smart-home" → "Smart home", with the few
// initialisms kept upper case.
const CATEGORY_LABELS: Readonly<Record<string, string>> = { crm: "CRM", iot: "IoT" };
export function categoryLabel(key: string): string {
  const known = CATEGORY_LABELS[key];
  if (known) return known;
  const words = key.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "3 tools · 1 makes changes", or "· read-only" when none of them change anything.
function toolSummary(tools: readonly ToolItem[]): string {
  const changes = tools.filter((tool) => tool.makesChange).length;
  const count = `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  return changes === 0
    ? `${count} · read-only`
    : `${count} · ${changes} ${changes === 1 ? "makes" : "make"} changes`;
}

// The Connect control for one catalogue entry. LIVE (bound to `connectAction`, carrying
// THIS entry's connector id) when an action is supplied; otherwise DISABLED with a
// one-line reason — never a live button over a missing action.
function ConnectControl({
  item,
  connectAction,
}: {
  item: CatalogueItem;
  connectAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!item.connectable)
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Unavailable
        </button>
        <p className="text-xs text-fg-muted">
          {item.unavailableReason ?? "Provider sign-in is not configured yet."}
        </p>
      </div>
    );
  if (!connectAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Connect
        </button>
        <p className="text-xs text-fg-muted">
          Connecting isn&apos;t available just now.
        </p>
      </div>
    );
  }
  return (
    <form action={connectAction}>
      <input type="hidden" name="connectorId" value={item.id} />
      <button type="submit" className={BTN_SECONDARY}>
        {item.connected ? "Connect another account" : "Connect"}
      </button>
    </form>
  );
}

// The ask-to-join funnel for a gated Google entry. It FILES a connector request, so it is
// bound to `requestAction` and carries the gated connector's id. LIVE when an action is
// supplied; otherwise DISABLED with a one-line reason.
function AskToJoinControl({
  item,
  requestAction,
}: {
  item: CatalogueItem;
  requestAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!requestAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          {EARLY_ACCESS_LABEL}
        </button>
        <p className="text-xs text-fg-muted">
          Early access isn&apos;t available just now.
        </p>
      </div>
    );
  }
  return (
    <form action={requestAction}>
      <input type="hidden" name="connectorId" value={item.id} />
      <button type="submit" className={BTN_SECONDARY}>
        {EARLY_ACCESS_LABEL}
      </button>
    </form>
  );
}

function CatalogueEntry({
  item,
  connectAction,
  requestAction,
}: {
  item: CatalogueItem;
  connectAction?: (formData: FormData) => void | Promise<void>;
  requestAction?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <li className="flex min-w-0 flex-col items-start gap-3 wh-card rounded-card border border-line bg-surface p-4">
      <div className="min-w-0 w-full">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="flex min-w-0 items-center gap-3">
            <ServiceMark id={item.id} name={item.name} size="md" />
            <span className="font-medium text-fg">{item.name}</span>
          </span>
          {item.connected ? <Status status="connected" /> : null}
        </div>
        <p className="text-xs text-fg-muted">{item.verification ?? "Configured integration · live verification not recorded"}</p>
        <a className="text-xs text-accent underline" href="/help/compatibility#connector-verification">What has been verified</a>
      </div>
      {item.gate === "ask_to_join" ? (
        <AskToJoinControl item={item} requestAction={requestAction} />
      ) : (
        <ConnectControl item={item} connectAction={connectAction} />
      )}
    </li>
  );
}

function CategorySection({
  group,
  connectAction,
  requestAction,
}: {
  group: CatalogueGroup;
  connectAction?: (formData: FormData) => void | Promise<void>;
  requestAction?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg-muted">
        {categoryLabel(group.category)}
      </h3>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {group.items.map((item) => (
          <CatalogueEntry
            key={item.id}
            item={item}
            connectAction={connectAction}
            requestAction={requestAction}
          />
        ))}
      </ul>
    </section>
  );
}

// The "Request a connector" affordance for a miss. LIVE (bound to `requestAction`, with a
// field prefilled with the searched term so the request names the missing service) when an
// action is supplied; otherwise DISABLED with a one-line reason.
function RequestSection({
  query,
  requestAction,
}: {
  query: string | null;
  requestAction?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 wh-card rounded-card border border-line bg-surface p-4 [overflow-wrap:anywhere]">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-fg">
          Can&apos;t find what you need?
        </h3>
        <p className="text-sm text-fg-muted">
          Tell us which service to add next.
        </p>
      </div>
      {requestAction ? (
        <form
          action={requestAction}
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="connector-request-name">Service name</Label>
            <Input
              id="connector-request-name"
              name="name"
              defaultValue={query ?? ""}
              placeholder="Which service?"
            />
          </div>
          <button type="submit" className={BTN_SECONDARY}>
            {REQUEST_LABEL}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-1">
          <button type="button" disabled className={BTN_DISABLED}>
            {REQUEST_LABEL}
          </button>
          <p className="text-xs text-fg-muted">
            Requesting a connector isn&apos;t available right now.
          </p>
        </div>
      )}
    </div>
  );
}

// The Disconnect control for one connection. LIVE (bound to `disconnectAction`, carrying
// THIS connection's id) when an action is supplied — one click, as the brief requires;
// otherwise DISABLED with a one-line reason — the same pattern as AgentListView.
function DisconnectControl({
  connectionId,
  disconnectAction,
}: {
  connectionId: string;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!disconnectAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Disconnect
        </button>
        <p className="text-xs text-fg-muted">
          Disconnecting isn&apos;t available just now.
        </p>
      </div>
    );
  }
  return (
    <form action={disconnectAction}>
      <input type="hidden" name="connectionId" value={connectionId} />
      <button type="submit" className={BTN_SECONDARY}>
        Disconnect
      </button>
    </form>
  );
}

function ConnectionCard({
  connection,
  reconnectAction,
  disconnectAction,
}: {
  connection: ConnectionItem;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
  reconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-3 wh-card rounded-card border border-line bg-surface p-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceMark id={connection.connectorId} name={connection.name} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-fg">{connection.name}</span>
            <span className="text-sm text-fg-muted">
              {connection.accountLabel}
            </span>
          </div>
        </div>
        <Status status={connection.status} />
      </div>

      <p className="text-sm text-fg-muted">
        Connected {connection.connectedAt}
      </p>
      {connection.unavailableReason ? (
        <p className="text-sm text-warning">{connection.unavailableReason}</p>
      ) : null}

      <div className="flex flex-col gap-1">
        {connection.tools.length === 0 ? (
          <p className="text-sm text-fg-muted">No tools yet.</p>
        ) : (
          <>
            <p className="text-sm text-fg">{toolSummary(connection.tools)}</p>
            <details>
              <summary className={SUMMARY_LINK}>Show tools</summary>
              <ul className="flex flex-col gap-1.5 pb-1">
                {connection.tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="flex flex-wrap items-center gap-2 text-sm text-fg"
                  >
                    <span>{toolLabel(tool.name)}</span>
                    <code className="text-xs text-fg-muted">{tool.name}</code>
                    <span className={`wh-tone-badge ${tool.makesChange ? "wh-tone-warning" : "wh-tone-info"}`}>
                      {tool.makesChange ? "Makes changes" : "Reads"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>

      <p className="text-sm text-fg-muted">
        {connection.agents.length === 0
          ? "No agents yet."
          : `Used by ${connection.agents.join(", ")}`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {connection.reconnectable && reconnectAction && (
          <form action={reconnectAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <button type="submit" className={BTN_SECONDARY}>
              Reconnect and refresh tools
            </button>
          </form>
        )}
        <DisconnectControl
          connectionId={connection.id}
          disconnectAction={disconnectAction}
        />
      </div>
    </li>
  );
}

// The category filter row: All first (the total), then every category with its count.
// Each link keeps the search text and the catalogue tab.
function CategoryLinks({
  categories,
  category,
  state,
}: {
  categories: readonly CategoryCount[];
  category: string | null;
  state: QueryState;
}) {
  const total = categories.reduce((sum, c) => sum + c.count, 0);
  return (
    <FilterLinks
      variant="scroll"
      label="Catalogue categories"
      items={[
        { label: "All", href: hrefWith(PATH, state, { category: undefined }), active: category === null, count: total },
        ...categories.map((c) => ({
          label: categoryLabel(c.key),
          href: hrefWith(PATH, state, { category: c.key }),
          active: c.key === category,
          count: c.count,
        })),
      ]}
    />
  );
}

// What clearing an empty, filtered catalogue removes, in words.
function clearLabel(query: string | null, category: string | null): string {
  if (query && category) return "Clear search and category";
  return query ? "Clear search" : "Show all categories";
}

export function ConnectorsView({
  initialView,
  groups,
  categories,
  category = null,
  connections,
  query,
  canRequest,
  connectAction,
  reconnectAction,
  disconnectAction,
  requestAction,
}: ConnectorsViewProps) {
  // The catalogue state every category link keeps (the tab, the search, the category).
  const catalogueState: QueryState = {
    view: "catalogue",
    q: query ?? undefined,
    category: category ?? undefined,
  };
  const filtered = Boolean(query) || category !== null;
  return (
    <div className="wh-page flex flex-col gap-8">
      <WorkspaceHeading eyebrow="Account resources" title="Connectors" description="Manage your connected accounts, or browse services to bring into your workspace." />
      <ViewPanels
        label="Connector views"
        defaultTab={filtered ? "catalogue" : "connected"}
        initialTab={initialView}
        tabs={[
          {
            key: "connected",
            label: `Connected services (${connections.length})`,
            content: (
              <section className="flex flex-col gap-4">
                <h2 className="text-lg font-semibold text-fg">
                  Your connected services
                </h2>

                {connections.length === 0 ? (
                  <EmptyState
                    heading="No connected services yet"
                    description="Once you link a service it'll show here with its status, tools and the agents that use it."
                  />
                ) : (
                  <ul className="flex flex-col gap-3">
                    {connections.map((connection) => (
                      <ConnectionCard
                        key={connection.id}
                        connection={connection}
                        reconnectAction={reconnectAction}
                        disconnectAction={disconnectAction}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ),
          },
          {
            key: "catalogue",
            label: "Catalogue",
            content: (
              <section className="flex flex-col gap-4">
                <h2 className="text-lg font-semibold text-fg">
                  Browse the catalogue
                </h2>

                <form
                  method="get"
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                >
                  <input type="hidden" name="view" value="catalogue" />
                  {category ? (
                    <input type="hidden" name="category" value={category} />
                  ) : null}
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="connector-search">Search</Label>
                    <Input
                      id="connector-search"
                      type="search"
                      name="q"
                      defaultValue={query ?? ""}
                      placeholder="Search connectors"
                    />
                  </div>
                  <button type="submit" className={BTN_SECONDARY}>
                    Search
                  </button>
                </form>

                {categories && categories.length > 0 ? (
                  <CategoryLinks
                    categories={categories}
                    category={category}
                    state={catalogueState}
                  />
                ) : null}

                {groups.length === 0 ? (
                  filtered ? (
                    <EmptyState
                      heading="No connectors match"
                      description={
                        category && !canRequest
                          ? `Nothing in ${categoryLabel(category)} matches your search. Try all categories.`
                          : "Nothing in the catalogue matches your search."
                      }
                      action={
                        <a
                          href={hrefWith(PATH, { view: "catalogue" })}
                          className="inline-flex min-h-11 items-center text-sm font-medium text-fg underline underline-offset-4"
                        >
                          {clearLabel(query, category)}
                        </a>
                      }
                    />
                  ) : (
                    <p className="text-sm text-fg-muted">
                      No connectors to show just now.
                    </p>
                  )
                ) : (
                  <div className="flex flex-col gap-6">
                    {groups.map((group) => (
                      <CategorySection
                        key={group.category}
                        group={group}
                        connectAction={connectAction}
                        requestAction={requestAction}
                      />
                    ))}
                  </div>
                )}

                {canRequest ? (
                  <RequestSection query={query} requestAction={requestAction} />
                ) : null}
              </section>
            ),
          },
        ]}
      />
    </div>
  );
}

export default ConnectorsView;
