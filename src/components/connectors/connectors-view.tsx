import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { ServiceMark } from "@/components/ui/brand-mark";
import { toolLabel } from "@/domain/activity/describe";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";

import { ViewPanels } from "@/components/ui/view-tabs";
import { Status, type StatusKey } from "@/components/ui/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { EmptyState } from "@/components/ui/empty";
import { FilterLinks } from "@/components/ui/filter-links";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { PageNotice, type NoticeTone } from "@/components/ui/notice";
import { hrefWith, type QueryState } from "@/lib/href";
import { catalogueGroupLabel } from "./catalogue-groups";
import { RevealOnFocus } from "./reveal-on-focus";

// E09-S16 — Connectors view component (src/components/connectors/connectors-view.tsx).
//
// The Connectors screen is a primary-journey surface (brief "Connector hub"; design §7;
// CLAUDE.md vocabulary — a *connector* is a catalogue entry, a *connection* is a person's
// connected service). It has two halves:
//   • the CATALOGUE — searchable and browsable BY CATEGORY, with a Connect control on each
//     entry, the "Early access — ask to join" funnel on a gated Google entry, and a
//     "Request a service" affordance on a miss (nothing matched the search); and
//   • the CONNECTED-SERVICES list — each connection showing its status, the account
//     connected, the connected date, the tools it offers (each marked "reads" or "makes
//     changes"), which agents may use it, and a one-click Disconnect.
//
// This is the PURE, prop-driven VIEW — exactly like AgentListView / DashboardView /
// ActivityView: it renders the screen from already-formatted props so it can be pinned
// without a browser, a session or any server plumbing. The loader reads/decrypts/formats
// and feeds it: dates arrive as pre-formatted LABELS, the per-person Google gate decision
// arrives as each catalogue item's `gate`, connection `status` is the shared StatusKey union
// the <Status> primitive renders, and the Connect / Disconnect / Request controls are BOUND
// to the server actions the page passes (exactly as AgentListView binds Disconnect). The
// view reaches for no clock, locale, DB or config.
//
// Colour comes from the design tokens (globals.css), never a raw hex.
//
// Layout (rule 1: no text on the canvas): the title and the two tabs share one heading
// band; the outcome of the last action sits straight under it. The catalogue is one
// toolbar (category chips, the search, a one-line count) and then ONE grid of compact
// service tiles in a panel, each tile naming its category — never a short grid per
// category, which left most rows two-thirds empty. With nothing narrowed, a "Popular" panel
// leads with the services most people connect first. Every control is a guarded form
// (one submission per click) that tells the page which tab, search and category to return
// to. Connected services are rows in one list group, with the tool summary ("n tools · n
// make changes") and the full list (each tool still marked "Reads" or "Makes changes")
// behind "Show tools". Disconnect stays one click (brief: "disconnect in one click").

// One catalogue entry as the view renders it. `connectable` is the index's own
// connectability truth (E09-S15). `gate` is the per-person decision (E09-S13): "connect"
// offers a Connect control; "ask_to_join" is a gated Google entry — the view shows the
// "Early access — ask to join" funnel instead of Connect. `category` is the display group
// the tile names ("Email", "Files and storage").
export type CatalogueItem = {
  id: string;
  name: string;
  category?: string;
  connectable: boolean;
  unavailableReason?: string;
  gate: "connect" | "ask_to_join";
  // The person already has at least one account of this service connected.
  connected?: boolean;
};

// The catalogue entries of one category, grouped so the view can name each tile's group
// (brief "searchable and browsable by category").
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

// The outcome of the last action, in plain words (the page maps `?notice=`).
export type ConnectorsNotice = { readonly tone: NoticeTone; readonly text: string };

export type ConnectorsViewProps = {
  initialView?: string;
  groups: readonly CatalogueGroup[];
  // The services most people connect first, shown above the full catalogue when nothing
  // narrows it (the loader leaves it empty during a search or inside a category).
  featured?: readonly CatalogueItem[];
  // Every category to filter by (validated by the loader), and the one chosen (null = all).
  categories?: readonly CategoryCount[];
  category?: string | null;
  connections: readonly ConnectionItem[];
  query: string | null; // the search term echoed back (prefill); null = no search
  canRequest: boolean; // a MISS → surface "Request a service"
  notice?: ConnectorsNotice | null;
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
// (the "—" is an em dash, U+2014). "Service" is what a person connects; "Connectors" is
// only the page's name.
const EARLY_ACCESS_LABEL = "Early access — ask to join";
const REQUEST_LABEL = "Request a service";

const PATH = "/connectors";

// A category key as a person reads it: a catalogue group's label ("files" → "Files and
// storage"), or any other slug in words ("smart-home" → "Smart home").
export function categoryLabel(key: string): string {
  return catalogueGroupLabel(key);
}

// "3 tools · 1 makes changes", or "· read-only" when none of them change anything.
function toolSummary(tools: readonly ToolItem[]): string {
  const changes = tools.filter((tool) => tool.makesChange).length;
  const count = `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  return changes === 0
    ? `${count} · read-only`
    : `${count} · ${changes} ${changes === 1 ? "makes" : "make"} changes`;
}

// Where an action should bring the person back to: the tab, and in the catalogue the
// search and category they were looking at. The page validates every value.
function ReturnState({ state }: { state: QueryState }) {
  return (
    <>
      {Object.entries(state).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={`return_${name}`} value={value} /> : null,
      )}
    </>
  );
}

// A control that exists but can't act right now: the button, dimmed, with its reason.
function Unavailable({ label, reason, service }: { label: string; reason: string; service?: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button type="button" variant="secondary" size="sm" disabled>
        {label}
        {service ? <span className="sr-only"> {service}</span> : null}
      </Button>
      <p className="text-xs text-fg-muted">{reason}</p>
    </div>
  );
}

// The Connect control for one catalogue entry. LIVE (bound to `connectAction`, carrying
// THIS entry's connector id) when an action is supplied; otherwise DISABLED with a
// one-line reason — never a live button over a missing action.
function ConnectControl({
  item,
  connectAction,
  state,
}: {
  item: CatalogueItem;
  connectAction?: (formData: FormData) => void | Promise<void>;
  state: QueryState;
}) {
  if (!item.connectable)
    return <Unavailable label="Not available yet" reason={item.unavailableReason ?? "This service can't be connected yet."} service={item.name} />;
  if (!connectAction) {
    return <Unavailable label="Connect" reason="Connecting isn't available just now." service={item.name} />;
  }
  return (
    <ActionForm action={connectAction}>
      <input type="hidden" name="connectorId" value={item.id} />
      <ReturnState state={state} />
      <FormSubmit variant="secondary" size="sm" pendingLabel="Connecting…">
        {item.connected ? "Connect another account" : "Connect"}
        <span className="sr-only"> {item.name}</span>
      </FormSubmit>
    </ActionForm>
  );
}

// The ask-to-join funnel for a gated Google entry. It FILES a connector request, so it is
// bound to `requestAction` and carries the gated connector's id. LIVE when an action is
// supplied; otherwise DISABLED with a one-line reason.
function AskToJoinControl({
  item,
  requestAction,
  state,
}: {
  item: CatalogueItem;
  requestAction?: (formData: FormData) => void | Promise<void>;
  state: QueryState;
}) {
  if (!requestAction) {
    return <Unavailable label={EARLY_ACCESS_LABEL} reason="Early access isn't available just now." service={item.name} />;
  }
  return (
    <ActionForm action={requestAction}>
      <input type="hidden" name="connectorId" value={item.id} />
      <ReturnState state={state} />
      <FormSubmit variant="secondary" size="sm" pendingLabel="Asking…">
        {EARLY_ACCESS_LABEL}
        <span className="sr-only"> for {item.name}</span>
      </FormSubmit>
    </ActionForm>
  );
}

// One service tile: its brand mark, name and category, a Connected badge when the person
// already has an account of it, and its one control. Inside the catalogue panel the tile is
// a muted inset (surfaces.css flattens a nested .wh-card), so there is no card-in-card.
function CatalogueEntry({
  item,
  connectAction,
  requestAction,
  state,
}: {
  item: CatalogueItem;
  connectAction?: (formData: FormData) => void | Promise<void>;
  requestAction?: (formData: FormData) => void | Promise<void>;
  state: QueryState;
}) {
  return (
    <li className="wh-card flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line bg-surface p-3">
      <ServiceMark id={item.id} name={item.name} size="md" />
      <div className="flex min-w-32 flex-1 flex-col">
        <span className="font-medium text-fg [overflow-wrap:anywhere]">{item.name}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
          {item.category ? <span>{categoryLabel(item.category)}</span> : null}
          {item.connected ? (
            <Badge tone="success" icon={CheckCircle2}>
              Connected
            </Badge>
          ) : null}
        </span>
      </div>
      {/* Beside the name in a phone's single column; under it, aligned with the name, once
          tiles share a row (so every tile in a row is the same height). */}
      <div className="ms-auto shrink-0 sm:ms-0 sm:basis-full sm:ps-11">
        {item.gate === "ask_to_join" ? (
          <AskToJoinControl item={item} requestAction={requestAction} state={state} />
        ) : (
          <ConnectControl item={item} connectAction={connectAction} state={state} />
        )}
      </div>
    </li>
  );
}

// A grid of tiles that fills each row evenly at every width (one column on phones, up to
// four on a wide desktop).
const TILE_GRID = "grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]";

// The "Request a service" affordance for a miss. LIVE (bound to `requestAction`, with a
// field prefilled with the searched term so the request names the missing service) when an
// action is supplied; otherwise DISABLED with a one-line reason.
function RequestPanel({
  query,
  requestAction,
  state,
}: {
  query: string | null;
  requestAction?: (formData: FormData) => void | Promise<void>;
  state: QueryState;
}) {
  return (
    <WorkspacePanel title="Can't find what you need?" description="Tell us which service to add next.">
      {requestAction ? (
        <ActionForm action={requestAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <ReturnState state={state} />
          <Field
            id="connector-request-name"
            name="name"
            label="Service name"
            defaultValue={query ?? ""}
            placeholder="Which service?"
            required
            maxLength={256}
            width="text"
            className="sm:flex-1"
          />
          <FormSubmit variant="secondary" pendingLabel="Sending request…">
            {REQUEST_LABEL}
          </FormSubmit>
        </ActionForm>
      ) : (
        <Unavailable label={REQUEST_LABEL} reason="Requesting a service isn't available right now." />
      )}
    </WorkspacePanel>
  );
}

// The Disconnect control for one connection. LIVE (bound to `disconnectAction`, carrying
// THIS connection's id) when an action is supplied — one click, as the brief requires;
// otherwise DISABLED with a one-line reason — the same pattern as AgentListView.
function DisconnectControl({
  connection,
  disconnectAction,
}: {
  connection: ConnectionItem;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!disconnectAction) {
    return <Unavailable label="Disconnect" reason="Disconnecting isn't available just now." service={connection.name} />;
  }
  return (
    <ActionForm action={disconnectAction}>
      <input type="hidden" name="connectionId" value={connection.id} />
      <ReturnState state={{ view: "connected" }} />
      <FormSubmit variant="danger" size="sm" pendingLabel="Disconnecting…">
        Disconnect
      </FormSubmit>
    </ActionForm>
  );
}

const SUMMARY_LINK =
  "inline-flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-field text-sm font-medium text-fg underline-offset-4 hover:underline lg:pointer-fine:min-h-9 [&::-webkit-details-marker]:hidden";

// One connected service, as a divider row in the "Your services" group.
function ConnectionRow({
  connection,
  reconnectAction,
  disconnectAction,
}: {
  connection: ConnectionItem;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
  reconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <li className={`${LIST_ROW} gap-3 py-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceMark id={connection.connectorId} name={connection.name} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-fg">{connection.name}</span>
            <span className="text-sm text-fg-muted">{connection.accountLabel}</span>
          </div>
        </div>
        <Status status={connection.status} />
      </div>

      <p className="text-sm text-fg-muted">
        Connected {connection.connectedAt}
        {" · "}
        {connection.agents.length === 0
          ? "No agents use it yet."
          : `Used by ${connection.agents.join(", ")}`}
      </p>
      {connection.unavailableReason ? (
        <p className="text-sm text-warning">{connection.unavailableReason}</p>
      ) : null}

      {connection.tools.length === 0 ? (
        <p className="text-sm text-fg-muted">No tools yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-fg">{toolSummary(connection.tools)}</p>
          <details>
            <summary className={SUMMARY_LINK}>Show tools</summary>
            <ul className="flex flex-col gap-1.5 pb-1">
              {connection.tools.map((tool) => (
                <li key={tool.name} className="flex flex-wrap items-center gap-2 text-sm text-fg">
                  <span>{toolLabel(tool.name)}</span>
                  <code className="text-xs text-fg-muted">{tool.name}</code>
                  <Badge tone={tool.makesChange ? "warning" : "info"}>
                    {tool.makesChange ? "Makes changes" : "Reads"}
                  </Badge>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {connection.reconnectable && reconnectAction && (
          <ActionForm action={reconnectAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <ReturnState state={{ view: "connected" }} />
            <FormSubmit variant="secondary" size="sm" pendingLabel="Reconnecting…">
              Reconnect and refresh tools
            </FormSubmit>
          </ActionForm>
        )}
        <DisconnectControl connection={connection} disconnectAction={disconnectAction} />
      </div>
    </li>
  );
}

// The category filter row: All first (the total), then every category with its count.
// Each link keeps the search text and the catalogue tab. On phones it scrolls in one line
// and keeps a focused chip fully in view.
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
    <RevealOnFocus>
      <FilterLinks
        variant="scroll"
        label="Service categories"
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
    </RevealOnFocus>
  );
}

// What clearing an empty, filtered catalogue removes, in words.
function clearLabel(query: string | null, category: string | null): string {
  if (query && category) return "Clear search and category";
  return query ? "Clear search" : "Show all categories";
}

// "106 services", "9 services in Email", "3 services match “mail” in Email".
function catalogueStatus(count: number, query: string | null, category: string | null): string {
  const services = `${count} ${count === 1 ? "service" : "services"}`;
  const where = category ? ` in ${categoryLabel(category)}` : "";
  if (query) return `${services} ${count === 1 ? "matches" : "match"} “${query}”${where}.`;
  return `${services}${where}.`;
}

export function ConnectorsView({
  initialView,
  groups,
  featured = [],
  categories,
  category = null,
  connections,
  query,
  canRequest,
  notice,
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
  const entries = groups.flatMap((group) =>
    group.items.map((item) => ({ ...item, category: item.category ?? group.category })),
  );
  // The outcome of the last action leads whichever tab is open, straight under the band.
  const outcome = notice ? <PageNotice tone={notice.tone}>{notice.text}</PageNotice> : null;
  const tile = (item: CatalogueItem) => (
    <CatalogueEntry
      key={item.id}
      item={item}
      connectAction={connectAction}
      requestAction={requestAction}
      state={catalogueState}
    />
  );
  return (
    <div className="wh-page">
      <ViewPanels
        label="Connector views"
        // With nothing connected yet, the page opens where the next step is: the catalogue.
        defaultTab={filtered || connections.length === 0 ? "catalogue" : "connected"}
        initialTab={initialView}
        heading={{
          title: "Connectors",
          description:
            "Connect your accounts, like email, calendar and files. Then choose which agents can use each one, on that agent's page.",
        }}
        tabs={[
          {
            key: "connected",
            label: `Your services (${connections.length})`,
            content: (
              <>
                {outcome}
                {connections.length === 0 ? (
                  <EmptyState
                    heading="No services connected yet"
                    description="Connect your email, calendar or files here. Each one then shows its status, its tools and the agents that use it."
                    action={
                      <ButtonLink href={hrefWith(PATH, { view: "catalogue" })} variant="primary">
                        Browse services
                      </ButtonLink>
                    }
                  />
                ) : (
                  <ListGroup
                    id="your-services"
                    title="Your services"
                    count={connections.length}
                    summary="An agent can use a service only after you turn it on for that agent."
                  >
                    {connections.map((connection) => (
                      <ConnectionRow
                        key={connection.id}
                        connection={connection}
                        reconnectAction={reconnectAction}
                        disconnectAction={disconnectAction}
                      />
                    ))}
                  </ListGroup>
                )}
              </>
            ),
          },
          {
            key: "catalogue",
            label: "Catalogue",
            content: (
              <>
                {outcome}
                <ListToolbar
                  label="Find a service"
                  filters={
                    categories && categories.length > 0 ? (
                      <CategoryLinks categories={categories} category={category} state={catalogueState} />
                    ) : null
                  }
                  search={
                    <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <input type="hidden" name="view" value="catalogue" />
                      {category ? <input type="hidden" name="category" value={category} /> : null}
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <label htmlFor="connector-search" className="text-sm font-medium text-fg">
                          Search services
                        </label>
                        <Input
                          id="connector-search"
                          type="search"
                          name="q"
                          defaultValue={query ?? ""}
                          placeholder="For example, Gmail or Dropbox"
                        />
                      </div>
                      <Button type="submit" variant="secondary">
                        Search
                      </Button>
                    </form>
                  }
                  status={catalogueStatus(entries.length, query, category)}
                />

                {featured.length > 0 ? (
                  <WorkspacePanel title="Popular" description="Where most people start: email, calendar and files.">
                    <ul role="list" className={TILE_GRID}>
                      {featured.map(tile)}
                    </ul>
                  </WorkspacePanel>
                ) : null}

                {entries.length === 0 ? (
                  filtered ? (
                    <EmptyState
                      heading="No services match"
                      description={
                        category && !canRequest
                          ? `Nothing in ${categoryLabel(category)} matches your search. Try all categories.`
                          : "Nothing in the catalogue matches your search."
                      }
                      action={
                        <ButtonLink href={hrefWith(PATH, { view: "catalogue" })} variant="secondary">
                          {clearLabel(query, category)}
                        </ButtonLink>
                      }
                    />
                  ) : (
                    <EmptyState
                      heading="No services to show just now"
                      description="Tell us which service you'd like to connect, and we'll look at adding it."
                    />
                  )
                ) : (
                  <WorkspacePanel
                    title={category ? categoryLabel(category) : "All services"}
                    description="Connecting a service gives no agent access yet. You choose that on each agent's page."
                  >
                    <ul role="list" className={TILE_GRID}>
                      {entries.map(tile)}
                    </ul>
                  </WorkspacePanel>
                )}

                {canRequest ? (
                  <RequestPanel query={query} requestAction={requestAction} state={catalogueState} />
                ) : null}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

export default ConnectorsView;
