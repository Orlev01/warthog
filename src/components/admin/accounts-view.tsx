import * as React from "react";
import { Bot, KeyRound, Plug, Search, Users } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { FilterLinks } from "@/components/ui/filter-links";
import { LIST_ROW, ListGroup } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { formatCount, formatDate, formatWhen, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import { ACCOUNT_FILTERS, type AccountFacts, type AccountFilter, type AccountRow, type AccountsModel } from "@/domain/admin/model";
import { BarList } from "./bar-list";
import { FactList } from "./fact-list";

// AccountsView — operational facts per account, never an address (docs/design/admin-portal.md §3, §5):
// one exact-address lookup (a GET form, so the address is never stored anywhere but the
// query the admin typed), then the accounts list keyed by sign-up date and an opaque reference,
// filterable to the step an account stalled at.

const FILTER_LABELS: Readonly<Record<AccountFilter, string>> = {
  all: "All accounts",
  no_factor: "No second factor",
  no_agent: "No agent yet",
  no_service: "No service yet",
  no_request: "No request yet",
  needs_reconnect: "Needs reconnecting",
};

function factorLabel(factors: AccountRow["factors"]): string {
  if (factors.length === 0) return "No second factor";
  return factors.map((f) => (f === "passkey" ? "Passkey" : "Authenticator")).join(" and ");
}

function AccountSummary({ account, timeZone, now }: { account: AccountRow; timeZone: string; now: Date }) {
  return (
    <span className="wh-timeline-meta">
      <span>Signed up {formatDate(account.createdAt, timeZone)}</span>
      <span>{factorLabel(account.factors)}</span>
      <span>{plural(account.agents, "agent")}</span>
      <span>{plural(account.connections, "service")}</span>
      <span>Last active {formatWhen(account.lastActiveAt, timeZone, now, "never")}</span>
      {account.pendingApprovals > 0 ? <span>{plural(account.pendingApprovals, "approval")} waiting</span> : null}
      {account.household ? <span>Household {account.household}</span> : null}
      {account.role === "admin" ? <span>Admin</span> : null}
    </span>
  );
}

function Flags({ account }: { account: AccountRow }) {
  if (account.factors.length > 0 && account.failingConnections === 0) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {account.factors.length === 0 ? <Badge tone="danger">No second factor</Badge> : null}
      {account.failingConnections > 0 ? <Badge tone="warning">{plural(account.failingConnections, "connection")} to reconnect</Badge> : null}
    </span>
  );
}

function LookupResult({ account, timeZone, now }: { account: AccountFacts; timeZone: string; now: Date }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg">Account <span className="font-medium tabular-nums">{account.reference}</span></p>
      <FactList label="Account facts" facts={[
        { key: "created", label: "Signed up", value: formatDate(account.createdAt, timeZone) },
        { key: "factor", label: "Second factor", value: factorLabel(account.factors) },
        { key: "active", label: "Last active", value: formatWhen(account.lastActiveAt, timeZone, now, "Never") },
        { key: "agents", label: "Agents", value: formatCount(account.agents) },
        { key: "requests", label: "Agent requests", value: formatCount(account.requestCount) },
        { key: "pending", label: "Approvals waiting", value: formatCount(account.pendingApprovals) },
      ]} />
      <Flags account={account} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="wh-group-title flex items-center gap-2"><Bot aria-hidden={true} size={16} /> Agents by platform</h3>
          <BarList label="Agents by platform" marks="agent" rows={account.agentsByPlatform} empty="No agent connected." />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="wh-group-title flex items-center gap-2"><Plug aria-hidden={true} size={16} /> Services</h3>
          <BarList label="Services" marks="service" rows={account.connectionsByConnector} empty="No service connected." />
        </div>
      </div>
    </div>
  );
}

export function AccountsView({ model, now }: { model: AccountsModel; now: Date }) {
  const filters = ACCOUNT_FILTERS.map((key) => ({
    label: FILTER_LABELS[key],
    href: key === "all" ? "/accounts" : `/accounts?filter=${key}`,
    active: model.filter === key,
    count: model.counts[key],
  }));
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Accounts"
        description={`How each account is going, without reading anything personal: no addresses are listed here. ${timeZoneNote(model.timeZone)}`}
        meta={`${plural(model.total, "account")} · ${formatCount(model.counts.no_factor)} without a second factor · ${formatCount(model.counts.needs_reconnect)} needing a reconnection`}
        scope={false}
      />
      <WorkspacePanel title="Look up an account" icon={Search} description="One exact email address shows that account's operational facts. Nothing here reveals what the account holds.">
        <form method="get" action="/accounts" className="wh-admin-lookup">
          <Field label="Email address" name="email" type="email" autoComplete="off" inputMode="email" required defaultValue="" />
          <Button type="submit" variant="secondary">
            <Search aria-hidden={true} className="h-4 w-4 shrink-0" />
            Look up
          </Button>
        </form>
        {model.lookup.searched ? (
          <div className="mt-4">
            {model.lookup.account ? (
              <LookupResult account={model.lookup.account} timeZone={model.timeZone} now={now} />
            ) : (
              <EmptyState variant="inline" icon={KeyRound} heading="No account has that address." description="Check the spelling, or ask the person which address they signed up with." />
            )}
          </div>
        ) : null}
      </WorkspacePanel>
      <ListToolbar label="Narrow the accounts" views={<FilterLinks label="Account filters" items={filters} variant="scroll" />} status={`Showing ${plural(model.accounts.length, "account")} of ${formatCount(model.counts[model.filter])} for ${FILTER_LABELS[model.filter].toLowerCase()}.`} />
      {model.accounts.length === 0 ? (
        <EmptyState icon={Users} heading={model.filter === "all" ? "No accounts yet" : "No accounts match this filter"} description={model.filter === "all" ? "Accounts appear here as people sign up." : "Try another filter, or all accounts."} />
      ) : (
        <ListGroup id="accounts" title="Accounts" count={model.counts[model.filter]} summary="Newest first. Each account is named only by a short reference.">
          {model.accounts.map((account) => (
            <li key={account.reference} className={LIST_ROW}>
              <span className="text-sm font-medium tabular-nums">Account {account.reference}</span>
              <AccountSummary account={account} timeZone={model.timeZone} now={now} />
              <Flags account={account} />
            </li>
          ))}
        </ListGroup>
      )}
    </div>
  );
}
