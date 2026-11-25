"use client";

import * as React from "react";
import { ReceiptText, Wallet } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup } from "@/components/ui/list-group";
import { FilterLinks } from "@/components/ui/filter-links";
import { EmptyState } from "@/components/ui/empty";
import { Notice } from "@/components/ui/notice";
import { CopyButton } from "@/components/ui/copy-button";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { billsView, intervalWords, paymentSources, type BillRecord, type Interval, type PaidBill, type PaymentSource } from "@/domain/life-admin/bills";
import { calendarDate } from "@/domain/life-admin/normalise";
import type { RecordTypeDef } from "@/domain/life-admin/record-types";
import { billsHref, billsPrompt, monthlyWords } from "./record-groups";
import { dueLabelOf, formatCalendarDate, moneyText, recordName } from "./record-format";
import { RecordReturnProvider } from "./record-forms";
import { RecordRow, itemHref } from "./record-row";
import { CostLine } from "./records-view";
import type { AssetOption, BillsGrouping, LifeAdminRecordView, RecordActions } from "./record-view-types";

// Bills (docs/adr/life-admin-profile.md, "The Bills tab"; founder, 25 Nov 2026): everything the
// person pays on repeat, across every category (subscriptions, utilities, rent, insurance, rego,
// a card's annual fee …), worked out by the one bills rule (domain/life-admin/bills.ts). Nothing is
// filed under Bills: it is a view of the records already on file. Top to bottom:
//
//   1. What it comes to a month, each currency apart (never added together), and how many bills
//      aren't in that figure yet (no cost or how often) or aren't checked yet.
//   2. By date (the default) or by account (`?bills=account`), as links that reload the page.
//   3. By date: Overdue (a bill the person pays by hand whose date has passed), the next 30 days,
//      later, and the date not known yet (dearest first). By account: each card or bank account a
//      bill comes out of, with what it comes to a month (a closed one warns that bills still point
//      to it), then what "Paid with" says when it matched none, as written, then not known yet.
//   4. When something is missing (a date, a cost, what it comes out of), a prompt to copy into an
//      agent to fill it in; with no bills at all, an empty state with the same prompt.
//
// Each bill is the record's own row (its Details, with Edit, one click away), so the person can
// fill in Paid with and Next payment right here; an action on it comes back to Bills. The row's
// line says when the next payment is in the kind's words ("Renews 25 Feb 2027"), or "Next payment
// about 3 Dec 2026 (estimated)" when Warthog worked it out from the cycle (shown only: stored
// dates and reminders don't move). Rows carry `data-record`, not a second `record-<id>` anchor.
// Every link is internal (an item's own page, or this tab): what Paid with and the account's email
// say is text, never a link and never `mailto:`, because an agent may have read it from email.

/** Each record's kind, from the person's catalogue, for the bills rule. */
export function billTypes(records: readonly LifeAdminRecordView[], catalogue: Catalogue): (record: BillRecord) => RecordTypeDef | null {
  const types = new Map(records.map((record) => [record.id, catalogue.typeOfRecord(record.kind, record.type ?? null)] as const));
  return (record) => types.get(record.id) ?? null;
}

/** What Paid with suggests in the Add and Edit forms: the person's open cards and bank accounts, each once. */
export function paymentSourceLabels(records: readonly LifeAdminRecordView[], catalogue: Catalogue): string[] {
  return [...new Set(paymentSources(records, billTypes(records, catalogue)).filter((source) => !source.closed).map((source) => source.label))];
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// "Monthly", "Every 6 months": how often, when the cost isn't known.
function oftenWords(interval: Interval): string {
  if (interval.unit === "week") return interval.count === 1 ? "Weekly" : interval.count === 2 ? "Fortnightly" : `Every ${interval.count} weeks`;
  if (interval.count === 1) return "Monthly";
  if (interval.count === 3) return "Quarterly";
  if (interval.count === 12) return "Yearly";
  const words = intervalWords(interval);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * When the next payment is, in words: the kind's own ("Renews 25 Feb 2027") when it is the kind's
 * own date, "Next payment …" when it is the record's Next payment, "about … (estimated)" when
 * Warthog moved it on by the cycle, "Was due …" when it's overdue, else the date it last had.
 */
export function billWhen(bill: PaidBill, type: RecordTypeDef, record: Pick<LifeAdminRecordView, "fields">): string | null {
  if (bill.next) {
    const date = formatCalendarDate(bill.next.date);
    if (bill.overdue) return `Was due ${date}`;
    if (bill.next.estimated) return `Next payment about ${date} (estimated)`;
    const own = !calendarDate((record.fields.next_payment ?? "").trim());
    return `${own ? dueLabelOf(type) : "Next payment"} ${date}`;
  }
  return bill.lastKnown ? `Last known ${formatCalendarDate(bill.lastKnown)}` : null;
}

/** What it costs and how often ("AUD 42.99 a year"), saying what isn't known yet. */
export function billCostWords(bill: Pick<PaidBill, "amount" | "currency" | "interval">): string {
  const money = bill.amount !== null ? `${bill.currency} ${moneyText(bill.amount)}` : null;
  if (money && bill.interval) return `${money} ${intervalWords(bill.interval)}`;
  if (money) return `${money} · How often not known yet`;
  return bill.interval ? `Cost not known yet · ${oftenWords(bill.interval)}` : "Cost not known yet · How often not known yet";
}

type Context = {
  catalogue: Catalogue;
  byId: ReadonlyMap<string, LifeAdminRecordView>;
  typeOf: (record: BillRecord) => RecordTypeDef | null;
  names: ReadonlyMap<string, string>;
  assets: readonly AssetOption[];
  zone: string;
  currentYear: string;
  actions: RecordActions;
  group: BillsGrouping;
};

// What it comes out of ("From <the card's page>", or Paid with as written) and the address it's
// registered to, as text; null when there's nothing to say. Grouped by account, the group already
// says what it comes out of.
function paidLine(bill: PaidBill, showPaid: boolean): React.ReactNode {
  const paid = !showPaid ? null : bill.paidFrom?.id === bill.id ? (
    "Charged to this card"
  ) : bill.paidFrom ? (
    <>
      From{" "}
      <a href={itemHref(bill.paidFrom.id)} className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4 lg:pointer-fine:min-h-0">
        {bill.paidFrom.label}
      </a>
      {bill.paidFrom.closed ? " (closed)" : null}
    </>
  ) : bill.paidWith ? (
    `Paid with: ${bill.paidWith}`
  ) : (
    "Paid with: not known yet"
  );
  const registered = bill.accountEmail ? `Registered to ${bill.accountEmail}` : null;
  if (!paid && !registered) return null;
  return (
    <p className="min-w-0">
      {paid}
      {paid && registered ? " · " : null}
      {registered}
    </p>
  );
}

function BillRow({ bill, ctx }: { bill: PaidBill; ctx: Context }) {
  const record = ctx.byId.get(bill.id);
  const type = record ? ctx.typeOf(record) : null;
  if (!record || !type) return null;
  const when = billWhen(bill, type, record) ?? (ctx.group === "account" ? "Date not known yet" : null);
  const summary = [when, billCostWords(bill), ctx.catalogue.category(bill.category)?.label ?? null].filter(Boolean).join(" · ");
  const parent = record.parentId && record.parentId !== record.id ? ctx.names.get(record.parentId) ?? null : null;
  return (
    <RecordRow
      record={record}
      type={type}
      catalogue={ctx.catalogue}
      partOf={parent}
      summary={summary}
      extra={paidLine(bill, ctx.group === "date")}
      anchor={false}
      assets={ctx.assets}
      zone={ctx.zone}
      currentYear={ctx.currentYear}
      actions={ctx.actions}
    />
  );
}

// The prompt to copy into an agent, as text the person can read first.
function AskAgent({ title, lead }: { title: string; lead?: string }) {
  const prompt = billsPrompt();
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-card bg-surface-muted p-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {lead ? <p className="mt-1 text-sm text-fg-muted">{lead}</p> : null}
        <p className="mt-1 text-sm text-fg [overflow-wrap:anywhere]">{prompt}</p>
      </div>
      <CopyButton value={prompt} label="prompt for your agent" />
    </div>
  );
}

/**
 * When one bill is most of a total (rent, usually), say so: "Lease, Unit 44 is AUD 4,766.68 of
 * that". The founder read AUD 5,060 a month as a mistake until they saw it was mostly rent.
 */
export function largestShare(bills: readonly PaidBill[], of: string): string | null {
  const counted = bills.filter((bill) => bill.monthly !== null);
  if (counted.length < 2) return null;
  const totals = new Map<string, number>();
  for (const bill of counted) totals.set(bill.currency, (totals.get(bill.currency) ?? 0) + bill.monthly!);
  const top = [...counted].sort((a, b) => b.monthly! - a.monthly!)[0]!;
  const total = totals.get(top.currency)!;
  return top.monthly! >= total / 2 && top.monthly! < total ? `${top.name} is ${top.currency} ${moneyText(top.monthly!)} of ${of}` : null;
}

function closedWords(source: PaymentSource, bills: number): string {
  const what = source.typeId === "banking.card" ? "card" : "account";
  return `This ${what} is closed: ${plural(bills, "bill still points", "bills still point")} to it. Change Paid with on each to what it comes out of now.`;
}

function DateGroups({ view, ctx }: { view: ReturnType<typeof billsView>; ctx: Context }) {
  const groups = [
    { key: "overdue", title: "Overdue", summary: "Paid by you, and the date has passed.", rows: view.overdue },
    { key: "soon", title: "Next 30 days", rows: view.soon },
    { key: "later", title: "Later", rows: view.later },
    { key: "unknown", title: "Date not known yet", summary: "Dearest first. Add Next payment in Edit, or ask your agent.", rows: view.unknown },
  ].filter((group) => group.rows.length > 0);
  return (
    <>
      {groups.map((group) => (
        <ListGroup key={group.key} id={`bills-${group.key}`} level={3} title={group.title} count={group.rows.length} summary={group.summary}>
          {group.rows.map((bill) => (
            <BillRow key={bill.id} bill={bill} ctx={ctx} />
          ))}
        </ListGroup>
      ))}
    </>
  );
}

function AccountGroups({ view, ctx }: { view: ReturnType<typeof billsView>; ctx: Context }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {view.accounts.map((account, index) => {
        const { source } = account;
        const title = source ? (
          <a href={itemHref(source.id)} className="underline-offset-4 hover:underline">
            {source.label}
          </a>
        ) : account.key === "unknown" ? (
          "Paid with not known yet"
        ) : (
          account.said
        );
        return (
          <div key={account.key} className="flex min-w-0 flex-col gap-3">
            {source?.closed ? (
              <Notice tone="warning" announce={false}>
                {closedWords(source, account.bills.length)}
              </Notice>
            ) : null}
            <ListGroup
              id={`bills-account-${index}`}
              level={3}
              title={title}
              count={account.bills.length}
              summary={account.monthly.length ? [`About ${monthlyWords(account.monthly)} a month`, largestShare(account.bills, "it")].filter(Boolean).join("; ") : "Cost not known yet"}
            >
              {account.bills.map((bill) => (
                <BillRow key={bill.id} bill={bill} ctx={ctx} />
              ))}
            </ListGroup>
          </div>
        );
      })}
    </div>
  );
}

export function BillsView({
  records,
  listed = records,
  catalogue,
  today,
  zone = "UTC",
  group = "date",
  assets = [],
  actions = {},
}: {
  // Every record the person has: their cards and accounts are found among all of them (a closed
  // card a bill still names, a card in a category they hid).
  records: readonly LifeAdminRecordView[];
  // The records shown on the page (none in a category they said is not for them): the bills.
  listed?: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  today: string;
  zone?: string;
  group?: BillsGrouping;
  assets?: readonly AssetOption[];
  actions?: RecordActions;
}) {
  const typeOf = billTypes(records, catalogue);
  const view = billsView(listed, typeOf, today, paymentSources(records, typeOf));
  const names = new Map(
    records.map((record) => {
      const type = catalogue.typeOfRecord(record.kind, record.type ?? null);
      return [record.id, recordName(type, record.fields, Boolean(record.type)).name] as const;
    }),
  );
  const ctx: Context = {
    catalogue,
    byId: new Map(listed.map((record) => [record.id, record] as const)),
    typeOf,
    names,
    assets,
    zone,
    currentYear: today.slice(0, 4),
    actions,
    group,
  };
  const all = [...view.overdue, ...view.soon, ...view.later, ...view.unknown];
  const missing = all.filter((bill) => bill.next === null || bill.monthly === null || (!bill.paidFrom && !bill.paidWith)).length;
  const estimated = all.some((bill) => bill.next?.estimated);
  const notes = [
    largestShare(all, "that"),
    view.uncounted > 0 ? `${view.uncounted} not counted yet (no cost or how often)` : null,
    view.notChecked > 0 ? `${view.notChecked} not checked yet` : null,
  ].filter(Boolean);
  return (
    <RecordReturnProvider value={{ tab: "bills", bills: group }}>
      <WorkspacePanel
        title="Bills"
        description="What you pay on repeat, from every category: what it costs, when the next payment is and which card or account it comes out of."
        icon={Wallet}
        footer={estimated ? "An estimated date is Warthog's working-out from the last date and how often. If it's wrong, set Next payment in Edit. Reminders keep to the dates you saved." : undefined}
      >
        {view.total === 0 ? (
          <div className="flex min-w-0 flex-col gap-4">
            <EmptyState
              variant="inline"
              icon={ReceiptText}
              heading="No bills yet"
              description="Subscriptions, utilities, rent, insurance, rego and card fees show here once they're in Life admin, with what each costs and what it comes out of."
            />
            <AskAgent title="Ask your agent" />
          </div>
        ) : (
          <>
            <div className="mb-4 flex min-w-0 flex-col gap-3">
              {view.monthly.length || notes.length ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <CostLine monthly={view.monthly} noun="bill" className="text-sm font-medium text-fg" />
                  {notes.length ? <p className="text-sm text-fg-muted">{notes.join(" · ")}</p> : null}
                </div>
              ) : null}
              <FilterLinks
                label="Group bills"
                items={[
                  { label: "By date", href: billsHref("date"), active: group === "date" },
                  { label: "By account", href: billsHref("account"), active: group === "account" },
                ]}
              />
            </div>
            {group === "account" ? <AccountGroups view={view} ctx={ctx} /> : <DateGroups view={view} ctx={ctx} />}
            {missing > 0 ? (
              <div className="mt-4">
                <AskAgent title="Ask your agent to fill these in" lead={`${plural(missing, "bill has", "bills have")} no date, cost or Paid with yet.`} />
              </div>
            ) : null}
          </>
        )}
      </WorkspacePanel>
    </RecordReturnProvider>
  );
}
