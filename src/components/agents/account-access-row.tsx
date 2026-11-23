import * as React from "react";
import { ChevronDown, Eye, PencilLine, TriangleAlert } from "lucide-react";

import { Select } from "@/components/ui/select";
import { ServiceMark } from "@/components/ui/brand-mark";
import { toolLabel } from "@/domain/activity/describe";
import { ACCOUNT_CONTROL } from "@/domain/permissions/workspace";

// One of the person's connected ACCOUNTS on an agent's Connectors section
// (docs/adr/several-accounts-per-agent.md): an agent can use several accounts of one service,
// each with its own on/off, reading, changes and tool choices, so each account is its own row.
// The collapsed header answers "can this agent use it, and how?" at a glance — the service's
// mark, "Gmail · billing@example.com", whether access is on, whether the account needs
// reconnecting, and a one-line read/change/tools summary — and expanding it shows the controls.
//
// Rows sit inside the section's one panel, divided by rules rather than boxed (UI/UX audit
// W-35: no cards inside cards). The row is self-contained — it takes the account, this agent's
// grant of it and the agent's defaults, and nothing else — so it can move to another tab as is.
// Every control keeps the stable name the save reads it by (ACCOUNT_CONTROL, keyed by the
// account's id) and stays a native uncontrolled input, so the save path and the unsaved-changes
// guard read it like any other control; the header summary follows the controls live through
// one delegated change listener.

export type ChangePolicy = "off" | "allow" | "ask_first";

// A connected account as its row shows it.
export type RowAccount = {
  // The account's (connection's) id: every control on the row is named by it.
  readonly id: string;
  readonly connectorId: string;
  // The service's name as people know it ("Gmail") and the account's own label (its address).
  readonly serviceName: string;
  readonly label: string;
  // False when the account needs reconnecting.
  readonly connected: boolean;
  // The account's tools by full name (`<connector>__<verb>`), read and change tools apart.
  readonly readTools: ReadonlyArray<string>;
  readonly changeTools: ReadonlyArray<string>;
};

// This agent's grant of the account. A setting left out follows the agent's own; null tools
// (or none) means every current and future tool.
export type RowGrant = {
  readonly readTools?: boolean;
  readonly changeTools?: ChangePolicy;
  readonly allowedTools?: ReadonlyArray<string> | null;
};

export type AccountAccessRowProps = {
  agentName: string;
  account: RowAccount;
  // null: the agent may not use this account.
  grant: RowGrant | null;
  // The agent-wide settings "Same as this agent's setting" follows.
  defaults: { readonly readTools: boolean; readonly changeTools: ChangePolicy };
  defaultOpen?: boolean;
};

const CHANGE_WORDS: Record<ChangePolicy, string> = {
  off: "Off",
  ask_first: "Ask me first",
  allow: "Allowed, subject to rules",
};

type Live = {
  granted: boolean;
  read: "default" | "on" | "off";
  change: "default" | ChangePolicy;
  scope: "all" | "chosen";
  checked: number;
};

function readForm(root: HTMLElement, id: string, previous: Live): Live {
  const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${CSS.escape(name)}"]`);
  const toggle = field(ACCOUNT_CONTROL.granted(id)) as HTMLInputElement | null;
  return {
    granted: toggle ? toggle.checked : previous.granted,
    read: (field(ACCOUNT_CONTROL.read(id))?.value ?? previous.read) as Live["read"],
    change: (field(ACCOUNT_CONTROL.change(id))?.value ?? previous.change) as Live["change"],
    scope: (field(ACCOUNT_CONTROL.toolScope(id))?.value ?? previous.scope) as Live["scope"],
    checked: root.querySelectorAll(`input[name="${CSS.escape(ACCOUNT_CONTROL.tool(id))}"]:checked`).length,
  };
}

function ToolList({ accountId, tools, allowed, status }: { accountId: string; tools: ReadonlyArray<string>; allowed: ReadonlyArray<string> | null; status?: string }) {
  return (
    <ul role="list" className="flex flex-col divide-y divide-line">
      {tools.map((tool) => (
        <li key={tool} className="flex flex-wrap items-center justify-between gap-x-3">
          <label className="flex min-h-11 min-w-0 items-center gap-3 py-1.5">
            <input type="checkbox" name={ACCOUNT_CONTROL.tool(accountId)} value={tool} defaultChecked={allowed === null || allowed.includes(tool)} className="h-4 w-4 shrink-0" />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm text-fg">{toolLabel(tool)}</span>
              <code className="text-xs text-fg-muted [overflow-wrap:anywhere]">{tool}</code>
            </span>
          </label>
          {status ? <span className="text-xs font-medium text-fg-muted">{status}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function AccountAccessRow({ agentName, account, grant, defaults, defaultOpen = false }: AccountAccessRowProps) {
  const total = account.readTools.length + account.changeTools.length;
  const allowed = grant?.allowedTools ?? null;
  const [live, setLive] = React.useState<Live>(() => ({
    granted: grant !== null,
    read: grant?.readTools === undefined ? "default" : grant.readTools ? "on" : "off",
    change: grant?.changeTools ?? "default",
    scope: allowed === null ? "all" : "chosen",
    checked: allowed === null ? total : [...account.readTools, ...account.changeTools].filter((tool) => allowed.includes(tool)).length,
  }));
  const ref = React.useRef<HTMLDetailsElement>(null);
  const onChange = () => {
    if (ref.current) setLive((previous) => readForm(ref.current!, account.id, previous));
  };

  const reads = live.read === "default" ? defaults.readTools : live.read === "on";
  const changes: ChangePolicy = live.change === "default" ? defaults.changeTools : live.change;
  const toolSummary = total === 0 ? "No tools found" : live.scope === "all" ? `All ${total} tools` : `${live.checked} of ${total} tools`;
  const headingId = `account-${account.id}-name`;

  return (
    <li className="min-w-0">
      <details ref={ref} open={defaultOpen} onChange={onChange} aria-labelledby={headingId} className="group">
        <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 rounded-field py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
          <span className={live.granted ? "shrink-0" : "shrink-0 [&_img]:opacity-70 [&_img]:grayscale"}>
            <ServiceMark id={account.connectorId} name={account.serviceName} size="md" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span id={headingId} className="font-semibold text-fg [overflow-wrap:anywhere]">
                {account.serviceName} · {account.label}
              </span>
              <span className={`wh-tone-badge ${live.granted ? "wh-tone-success" : "wh-tone-neutral"}`}>
                {live.granted ? `${agentName} can use it` : "Not allowed"}
              </span>
              {account.connected ? null : (
                <span className="wh-tone-badge wh-tone-warning">
                  <TriangleAlert aria-hidden={true} className="h-3.5 w-3.5" /> Reconnect needed
                </span>
              )}
            </span>
            {live.granted ? (
              <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
                <span className="inline-flex items-center gap-1">
                  <Eye aria-hidden={true} className="h-3.5 w-3.5 text-info" /> Reads {reads ? "allowed" : "off"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <PencilLine aria-hidden={true} className="h-3.5 w-3.5 text-warning" /> Changes: {CHANGE_WORDS[changes].toLowerCase()}
                </span>
                <span>{toolSummary}</span>
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-sm text-fg-muted">
            <span className="hidden sm:inline group-open:hidden">Edit</span>
            <span className="hidden sm:group-open:inline">Close</span>
            <ChevronDown aria-hidden={true} className="h-5 w-5 transition-transform group-open:rotate-180" />
          </span>
        </summary>

        <div className="flex flex-col gap-4 pb-4 sm:ps-12">
          {account.connected ? null : (
            <p className="flex items-start gap-2 text-sm text-fg">
              <TriangleAlert aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                This account needs reconnecting. {agentName} can&rsquo;t use it until you reconnect it on the{" "}
                <a href="/connectors" className="text-accent underline">Connectors page</a>.
              </span>
            </p>
          )}

          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" name={ACCOUNT_CONTROL.granted(account.id)} defaultChecked={grant !== null} className="mt-1 h-4 w-4 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-fg [overflow-wrap:anywhere]">Let {agentName} use {account.label}</span>
              <span className="text-sm text-fg-muted">Access follows this account&rsquo;s settings and your rules.</span>
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <span className="inline-flex items-center gap-1.5"><Eye aria-hidden={true} className="h-4 w-4 text-info" /> Reading</span>
              <Select name={ACCOUNT_CONTROL.read(account.id)} defaultValue={grant?.readTools === undefined ? "default" : grant.readTools ? "on" : "off"}>
                <option value="default">Same as this agent&rsquo;s setting ({defaults.readTools ? "allowed" : "off"})</option>
                <option value="on">Allowed</option>
                <option value="off">Off</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <span className="inline-flex items-center gap-1.5"><PencilLine aria-hidden={true} className="h-4 w-4 text-warning" /> Making changes</span>
              <Select name={ACCOUNT_CONTROL.change(account.id)} defaultValue={grant?.changeTools ?? "default"}>
                <option value="default">Same as this agent&rsquo;s setting ({CHANGE_WORDS[defaults.changeTools].toLowerCase()})</option>
                <option value="off">Off</option>
                <option value="ask_first">Ask me first</option>
                <option value="allow">Allow, subject to rules</option>
              </Select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Which tools
            <Select name={ACCOUNT_CONTROL.toolScope(account.id)} defaultValue={allowed === null ? "all" : "chosen"}>
              <option value="all">All tools, including new ones</option>
              <option value="chosen">Only the tools I tick</option>
            </Select>
            <span className="text-xs font-normal text-fg-muted">
              With &ldquo;Only the tools I tick&rdquo;, new tools this service adds stay off until you tick them. The reading and change settings above, and your rules for all agents, still apply. Tools run by an outside provider always ask you first, because Warthog can&rsquo;t check what they do.
            </span>
          </label>

          {total === 0 ? (
            <p className="text-sm text-fg-muted">We couldn&rsquo;t load this account&rsquo;s tools. Try reconnecting it on the Connectors page.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {account.readTools.length > 0 ? (
                <fieldset className="m-0 min-w-0 border-0 p-0">
                  <legend className="inline-flex items-center gap-1.5 pb-1 text-sm font-semibold text-fg">
                    <Eye aria-hidden={true} className="h-4 w-4 text-info" /> Reads ({account.readTools.length})
                  </legend>
                  <ToolList accountId={account.id} tools={account.readTools} allowed={allowed} />
                </fieldset>
              ) : null}
              {account.changeTools.length > 0 ? (
                <fieldset className="m-0 min-w-0 border-0 p-0">
                  <legend className="inline-flex items-center gap-1.5 pb-1 text-sm font-semibold text-fg">
                    <PencilLine aria-hidden={true} className="h-4 w-4 text-warning" /> Makes changes ({account.changeTools.length})
                  </legend>
                  <ToolList
                    accountId={account.id}
                    tools={account.changeTools}
                    allowed={allowed}
                    status={!live.granted || changes === "off" ? "Off" : CHANGE_WORDS[changes]}
                  />
                </fieldset>
              ) : null}
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
