import * as React from "react";
import { CheckCircle2, Inbox, RotateCcw } from "lucide-react";

import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { FilterLinks } from "@/components/ui/filter-links";
import { LIST_ROW, ListGroup } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { PageNotice, type NoticeTone } from "@/components/ui/notice";
import { formatCount, formatDate, formatWhen, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import {
  REQUEST_FILTERS,
  type BreakdownRow, type RequestFilter, type RequestItem, type RequestPerson, type RequestsModel, type RequestsNotice,
} from "@/domain/admin/model";

// RequestsView — what people have asked the operator for in the app (docs/adr/admin-portal.md,
// amendment of 20 November 2026). Each request names the person who asked (their address, as a
// mail link) with the same account facts the Accounts page shows, and says what would settle it.
// A request settles itself once the service is in the catalogue or the person is on the Google
// list; anything else the operator marks done here (and can put back).

const FILTER_LABELS: Readonly<Record<RequestFilter, string>> = {
  waiting: "Waiting",
  done: "Done",
  all: "All requests",
};

const NOTICES: Readonly<Record<RequestsNotice, { tone: NoticeTone; text: string }>> = {
  done: { tone: "success", text: "Marked done." },
  waiting: { tone: "success", text: "Moved back to waiting." },
  problem: { tone: "error", text: "That request couldn't be changed. Refresh the page and try again." },
};

const KIND_LABELS: Readonly<Record<RequestItem["kind"], string>> = {
  service: "New service",
  google_early_access: "Google early access",
  contact: "Message",
};

const LISTED = 5;
const EMAIL_LINK =
  "inline-flex min-h-11 min-w-0 items-center font-medium text-fg underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function names(rows: readonly BreakdownRow[]): string {
  const shown = rows.slice(0, LISTED).map((r) => (r.value > 1 ? `${r.label} ×${r.value}` : r.label));
  return rows.length > LISTED ? `${shown.join(", ")} and ${rows.length - LISTED} more` : shown.join(", ");
}

function factorLabel(factors: RequestPerson["factors"]): string {
  if (factors.length === 0) return "No second factor";
  return factors.map((f) => (f === "passkey" ? "Passkey" : "Authenticator")).join(" and ");
}

function PersonFacts({ person, timeZone, now }: { person: RequestPerson; timeZone: string; now: Date }) {
  const total = (rows: readonly BreakdownRow[]) => rows.reduce((n, r) => n + r.value, 0);
  const agents = total(person.agentsByPlatform);
  const services = total(person.connectionsByConnector);
  return (
    <span className="wh-timeline-meta">
      <span>Signed up {formatDate(person.createdAt, timeZone)}</span>
      <span>Last active {formatWhen(person.lastActiveAt, timeZone, now, "never")}</span>
      <span>{factorLabel(person.factors)}</span>
      <span>{agents === 0 ? "No agent yet" : `${plural(agents, "agent")} (${names(person.agentsByPlatform)})`}</span>
      <span>{services === 0 ? "No service yet" : `${plural(services, "service")} (${names(person.connectionsByConnector)})`}</span>
      {person.failingConnections > 0 ? <span>{plural(person.failingConnections, "connection")} to reconnect</span> : null}
      <span>{plural(person.agentRequests, "agent request")}</span>
      {person.pendingApprovals > 0 ? <span>{plural(person.pendingApprovals, "approval")} waiting</span> : null}
      {person.currency ? <span>Currency {person.currency}</span> : null}
      {person.household ? <span>Household {person.household}</span> : null}
      {person.requestsMade > 1 ? <span>{plural(person.requestsMade, "request")} from them</span> : null}
      {person.role === "admin" ? <span>Admin</span> : null}
    </span>
  );
}

function outcomeText(item: RequestItem, timeZone: string): string {
  const resolution = item.resolution;
  if (resolution?.by === "catalogue") return `${resolution.serviceName} is in the catalogue now, so they can connect it.`;
  if (resolution?.by === "allowlist") return "They're on the Google early-access list, so they can connect it.";
  if (resolution?.by === "operator") return `You marked this done on ${formatDate(resolution.at, timeZone)}.`;
  if (item.kind === "contact") return "Reply by email, then mark it done. They see it as answered.";
  return item.kind === "google_early_access"
    ? "To let them connect it, add their address to the Google early-access list."
    : "Not in the catalogue yet.";
}

function UpdateControl({ item, filter }: { item: RequestItem; filter: RequestFilter }) {
  const reopen = item.resolution?.by === "operator";
  if (item.resolution && !reopen) return null;
  return (
    <form method="post" action="/requests/update" className="mt-2">
      <input type="hidden" name="id" value={item.id} />
      <input type="hidden" name="to" value={reopen ? "waiting" : "done"} />
      <input type="hidden" name="filter" value={filter} />
      <Button type="submit" variant="secondary" size="sm">
        {reopen ? <RotateCcw aria-hidden={true} className="h-4 w-4 shrink-0" /> : <CheckCircle2 aria-hidden={true} className="h-4 w-4 shrink-0" />}
        {reopen ? "Move back to waiting" : "Mark done"}
        <span className="sr-only">: {item.serviceName} for {item.person.email}</span>
      </Button>
    </form>
  );
}

// A mail link to the person, with a subject. Every part is percent-encoded, so an address
// whose local part carries "?" or "&" can't add recipients or a body to the draft.
function mailLink(email: string, subject: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return `mailto:${encodeURIComponent(email.slice(0, at))}@${encodeURIComponent(email.slice(at + 1))}?subject=${encodeURIComponent(subject)}`;
}

function RequestRow({ item, filter, timeZone, now }: { item: RequestItem; filter: RequestFilter; timeZone: string; now: Date }) {
  const href = mailLink(
    item.person.email,
    item.kind === "contact" ? "Re: your message to Warthog" : `Your Warthog request: ${item.serviceName}`,
  );
  return (
    <li className={LIST_ROW}>
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{item.serviceName}</span>
        <Badge tone="neutral">{KIND_LABELS[item.kind]}</Badge>
        {item.resolution ? <Badge tone="success">Done</Badge> : <Badge tone="warning">Waiting</Badge>}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 text-sm">
        {href ? <a className={EMAIL_LINK} href={href}>{item.person.email}</a> : <span className="font-medium text-fg">{item.person.email}</span>}
        <span className="text-fg-muted">Account <span className="tabular-nums">{item.person.reference}</span> · asked {formatWhen(item.askedAt, timeZone, now)}</span>
      </span>
      {item.kind === "contact" && item.message ? (
        <p className="whitespace-pre-line rounded-field border border-line bg-surface-muted p-3 text-sm text-fg [overflow-wrap:anywhere]">
          {item.message}
        </p>
      ) : null}
      <PersonFacts person={item.person} timeZone={timeZone} now={now} />
      <span className="text-sm text-fg-muted">{outcomeText(item, timeZone)}</span>
      <UpdateControl item={item} filter={filter} />
    </li>
  );
}

const EMPTY: Readonly<Record<RequestFilter, { heading: string; description: string }>> = {
  waiting: { heading: "Nothing is waiting", description: "New requests for a service or for Google early access, and Contact us messages, appear here." },
  done: { heading: "Nothing is done yet", description: "Requests move here once they're settled." },
  all: { heading: "No requests yet", description: "When someone asks for a service that isn't in the catalogue, asks for Google early access, or sends a Contact us message, it appears here." },
};

export function RequestsView({ model, now }: { model: RequestsModel; now: Date }) {
  const filters = REQUEST_FILTERS.map((key) => ({
    label: FILTER_LABELS[key],
    href: key === "waiting" ? "/requests" : `/requests?filter=${key}`,
    active: model.filter === key,
    count: model.counts[key],
  }));
  const notice = model.notice ? NOTICES[model.notice] : null;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Requests"
        description={`What people have asked you for in Warthog, with who asked. This is the only page that shows addresses. ${timeZoneNote(model.timeZone)}`}
        meta={`${formatCount(model.counts.waiting)} waiting · ${plural(model.counts.all, "request")} in all`}
        scope={false}
      />
      {notice ? <PageNotice tone={notice.tone}>{notice.text}</PageNotice> : null}
      <ListToolbar label="Narrow the requests" views={<FilterLinks label="Request filters" items={filters} variant="scroll" />} status={`Showing ${plural(model.requests.length, "request")}, newest first.${model.capped ? " Only the newest 200 are read, so older ones aren't counted." : ""}`} />
      {model.requests.length === 0 ? (
        <EmptyState icon={Inbox} heading={EMPTY[model.filter].heading} description={EMPTY[model.filter].description} />
      ) : (
        <ListGroup id="requests" title={FILTER_LABELS[model.filter]} count={model.counts[model.filter]} summary="Newest first. Each request names the person who asked.">
          {model.requests.map((item) => (
            <RequestRow key={item.id} item={item} filter={model.filter} timeZone={model.timeZone} now={now} />
          ))}
        </ListGroup>
      )}
    </div>
  );
}
