import * as React from "react";
import { Filter, KeyRound, Milestone, UserPlus } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { EmptyState } from "@/components/ui/empty";
import { LIST_ROW, ListGroup } from "@/components/ui/list-group";
import { formatCount, formatShare, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import type { SignupsModel } from "@/domain/admin/model";
import { BarList } from "./bar-list";
import { Funnel } from "./funnel";
import { RangeTabs } from "./range-tabs";
import { Sparkline } from "./sparkline";
import { StatTiles } from "./stat-tiles";

// SignupsView — who is joining and how far they get (docs/design/admin-portal.md §5).

export function SignupsView({ model }: { model: SignupsModel }) {
  const { range } = model;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Sign-ups"
        description={`Who's joining, where sign-up stalls, and how far new accounts get. ${timeZoneNote(model.timeZone)}`}
        meta={`${plural(model.total.value, "sign-up")} ${range.label} · ${plural(model.activeAccounts, "account")} in total`}
        nav={<RangeTabs path="/signups" active={range.key} />}
        scope={false}
      />
      <StatTiles
        label="Sign-up numbers"
        tiles={[
          { key: "signups", label: "Sign-ups", value: formatCount(model.total.value), delta: { value: model.total.value, previous: model.total.previous, previousLabel: range.previousLabel }, sparkline: <Sparkline label={`Sign-ups per ${range.bucket}`} points={model.perBucket} /> },
          { key: "accounts", label: "Accounts", value: formatCount(model.activeAccounts), sub: "all time", href: "/accounts" },
        ]}
      />
      <div className="wh-dashboard-grid">
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Sign-up funnel" icon={Filter} description={`From the first code sent to a finished account, ${range.label}.`}>
            <Funnel label="Sign-up funnel" steps={model.funnel} empty="No one started signing up in this period. Try a longer range." />
          </WorkspacePanel>
          <WorkspacePanel title="Refusals" icon={UserPlus} description="Why a sign-up step was refused.">
            <BarList label="Refusals" rows={model.refusals} empty="No sign-up step was refused in this period." />
          </WorkspacePanel>
        </div>
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Second factor" icon={KeyRound} description="How finished sign-ups secured their account.">
            <BarList label="Second factor" rows={model.factors} empty="No sign-up finished in this period." />
          </WorkspacePanel>
          <WorkspacePanel title="Activation milestones" icon={Milestone} description="How many accounts reached each step, all time, and the median days it took.">
            {model.milestones.length === 0 ? (
              <EmptyState variant="inline" heading="No accounts yet." description="Milestones appear once the first account signs up." />
            ) : (
              <ListGroup id="milestones" title="Milestones" level={3}>
                {model.milestones.map((m) => (
                  <li key={m.key} className={LIST_ROW}>
                    <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-sm">
                      <span className="font-medium">{m.href ? <a href={m.href} className="underline underline-offset-4">{m.label}</a> : m.label}</span>
                      <span className="tabular-nums">{formatShare(m.reached, m.of)}</span>
                    </span>
                    <span className="wh-timeline-meta">
                      <span>{formatCount(m.reached)} of {formatCount(m.of)} accounts</span>
                      <span>{m.medianDays == null ? "No timing yet" : m.medianDays < 1 ? "Median: same day" : `Median: ${formatCount(Math.round(m.medianDays))} day${Math.round(m.medianDays) === 1 ? "" : "s"}`}</span>
                    </span>
                  </li>
                ))}
              </ListGroup>
            )}
          </WorkspacePanel>
        </div>
      </div>
    </div>
  );
}
