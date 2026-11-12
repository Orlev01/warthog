import * as React from "react";
import { ChevronDown, Eye, PencilLine, TriangleAlert } from "lucide-react";

import { Select } from "@/components/ui/select";
import { ServiceMark } from "@/components/ui/brand-mark";
import { toolLabel } from "@/domain/activity/describe";

// One connected service on an agent's Connectors section, as its own collapsible module
// (docs/adr/brand-marks-and-accent.md). The collapsed header answers "can this agent use
// it, with which account, and how?" at a glance — the service's mark and name, the chosen
// account, whether access is on, and a one-line read/change/tools summary — and expanding it
// shows the controls. Every control keeps the stable `name` the save reads it by, and stays
// a native uncontrolled input, so the save path is unchanged; the header summary follows the
// controls live through one delegated change listener.

export type ChangePolicy = "off" | "allow" | "ask_first";

export type ConnectorModuleProps = {
  agentName: string;
  connector: {
    accounts?: readonly { id: string; label: string }[];
    accountId?: string;
    policy?: { allowedTools?: string[] | null; readTools?: boolean; changeTools?: ChangePolicy };
    id: string;
    name: string;
    granted?: boolean;
    readTools: ReadonlyArray<string>;
    changeTools: ReadonlyArray<string>;
  };
  // The agent-wide defaults a "Same as this agent's setting" choice follows.
  defaultReads: boolean;
  defaultChanges: ChangePolicy;
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
  accountId: string;
};

function readForm(root: HTMLElement, id: string, previous: Live): Live {
  const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${CSS.escape(name)}"]`);
  const toggle = field(`connector:${id}`) as HTMLInputElement | null;
  return {
    granted: toggle ? toggle.checked : previous.granted,
    read: ((field(`connectorPolicyRead:${id}`)?.value ?? previous.read) as Live["read"]),
    change: ((field(`connectorPolicyChange:${id}`)?.value ?? previous.change) as Live["change"]),
    scope: ((field(`connectorToolScope:${id}`)?.value ?? previous.scope) as Live["scope"]),
    checked: root.querySelectorAll(`input[name="${CSS.escape(`connectorTool:${id}`)}"]:checked`).length,
    accountId: field(`connectorAccount:${id}`)?.value ?? previous.accountId,
  };
}

export function ConnectorModule({ agentName, connector, defaultReads, defaultChanges, defaultOpen = false }: ConnectorModuleProps) {
  const total = connector.readTools.length + connector.changeTools.length;
  const allowed = connector.policy?.allowedTools ?? null;
  const [live, setLive] = React.useState<Live>(() => ({
    granted: connector.granted ?? true,
    read: connector.policy?.readTools === undefined ? "default" : connector.policy.readTools ? "on" : "off",
    change: connector.policy?.changeTools ?? "default",
    scope: allowed === null ? "all" : "chosen",
    checked: allowed === null ? total : [...connector.readTools, ...connector.changeTools].filter((tool) => allowed.includes(tool)).length,
    accountId: connector.accountId ?? "",
  }));
  const ref = React.useRef<HTMLDetailsElement>(null);
  const onChange = () => {
    if (ref.current) setLive((previous) => readForm(ref.current!, connector.id, previous));
  };

  const reads = live.read === "default" ? defaultReads : live.read === "on";
  const changes: ChangePolicy = live.change === "default" ? defaultChanges : live.change;
  const account = connector.accounts?.find((option) => option.id === live.accountId)?.label;
  const needsAccount = (connector.accounts?.length ?? 0) > 1 && !live.accountId;
  const toolSummary = total === 0 ? "No tools found" : live.scope === "all" ? `All ${total} tools` : `${live.checked} of ${total} tools`;
  const headingId = `connector-${connector.id}-name`;

  return (
    <details
      ref={ref}
      open={defaultOpen || needsAccount}
      onChange={onChange}
      className={`wh-connector-module group ${live.granted ? "" : "wh-connector-module--off"}`}
    >
      <summary className="wh-connector-summary">
        <ServiceMark id={connector.id} name={connector.name} size="lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span id={headingId} className="font-semibold text-fg [overflow-wrap:anywhere]">{connector.name}</span>
            <span className={`wh-tone-badge ${live.granted ? "wh-tone-success" : "wh-tone-neutral"}`}>
              {live.granted ? `${agentName} can use it` : "Not allowed"}
            </span>
          </span>
          <span className="text-sm text-fg-muted [overflow-wrap:anywhere]">
            {needsAccount ? (
              <span className="inline-flex items-center gap-1 text-fg">
                <TriangleAlert aria-hidden={true} className="h-4 w-4 text-warning" /> Choose an account
              </span>
            ) : (
              account ?? (connector.accounts?.length === 1 ? connector.accounts[0]!.label : "Connected account")
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

      <div className="wh-connector-body">
        {connector.granted === undefined ? null : (
          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" name={`connector:${connector.id}`} defaultChecked={connector.granted} className="mt-1 h-4 w-4 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-fg">Let {agentName} use {connector.name}</span>
              <span className="text-sm text-fg-muted">Access follows this service’s settings and your rules.</span>
            </span>
          </label>
        )}

        {connector.accounts?.length ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Account {agentName} uses
            <Select name={`connectorAccount:${connector.id}`} defaultValue={connector.accountId ?? ""}>
              <option value="">Choose an account</option>
              {connector.accounts.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
            {connector.accounts.length > 1 ? (
              <span className="text-xs font-normal text-fg-muted">
                With more than one account connected, an account must be chosen before {agentName} can use {connector.name}.
              </span>
            ) : null}
          </label>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <span className="inline-flex items-center gap-1.5"><Eye aria-hidden={true} className="h-4 w-4 text-info" /> Reading</span>
            <Select
              name={`connectorPolicyRead:${connector.id}`}
              defaultValue={connector.policy?.readTools === undefined ? "default" : connector.policy.readTools ? "on" : "off"}
            >
              <option value="default">Same as this agent’s setting ({defaultReads ? "allowed" : "off"})</option>
              <option value="on">Allowed</option>
              <option value="off">Off</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <span className="inline-flex items-center gap-1.5"><PencilLine aria-hidden={true} className="h-4 w-4 text-warning" /> Making changes</span>
            <Select name={`connectorPolicyChange:${connector.id}`} defaultValue={connector.policy?.changeTools ?? "default"}>
              <option value="default">Same as this agent’s setting ({CHANGE_WORDS[defaultChanges].toLowerCase()})</option>
              <option value="off">Off</option>
              <option value="ask_first">Ask me first</option>
              <option value="allow">Allow, subject to rules</option>
            </Select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Which tools
          <Select name={`connectorToolScope:${connector.id}`} defaultValue={allowed === null ? "all" : "chosen"}>
            <option value="all">All tools, including new ones</option>
            <option value="chosen">Only the tools I tick</option>
          </Select>
          <span className="text-xs font-normal text-fg-muted">
            With “Only the tools I tick”, new tools this service adds stay off until you tick them. The reading and change settings above, and your rules for all agents, still apply. Tools run by an outside provider always ask you first, because Warthog can’t check what they do.
          </span>
        </label>

        {total === 0 ? (
          <p className="text-sm text-fg-muted">We couldn&rsquo;t load this account&rsquo;s tools. Choose its account above, or try reconnecting it on the Connectors page.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {connector.readTools.length > 0 ? (
              <fieldset className="wh-tool-group wh-tone-info">
                <legend className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
                  <Eye aria-hidden={true} className="h-4 w-4 wh-tone-icon" /> Reads ({connector.readTools.length})
                </legend>
                <ul role="list" className="flex flex-col">
                  {connector.readTools.map((tool) => (
                    <li key={tool} className="border-b border-line last:border-0">
                      <label className="flex min-h-11 items-center gap-3 py-1.5">
                        <input type="checkbox" name={`connectorTool:${connector.id}`} value={tool} defaultChecked={allowed === null || allowed.includes(tool)} className="h-4 w-4 shrink-0" />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm text-fg">{toolLabel(tool)}</span>
                          <code className="text-xs text-fg-muted [overflow-wrap:anywhere]">{tool}</code>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
            {connector.changeTools.length > 0 ? (
              <fieldset className="wh-tool-group wh-tone-warning">
                <legend className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
                  <PencilLine aria-hidden={true} className="h-4 w-4 wh-tone-icon" /> Makes changes ({connector.changeTools.length})
                </legend>
                <ul role="list" className="flex flex-col">
                  {connector.changeTools.map((tool) => (
                    <li key={tool} className="flex flex-wrap items-center justify-between gap-x-3 border-b border-line last:border-0">
                      <label className="flex min-h-11 min-w-0 items-center gap-3 py-1.5">
                        <input type="checkbox" name={`connectorTool:${connector.id}`} value={tool} defaultChecked={allowed === null || allowed.includes(tool)} className="h-4 w-4 shrink-0" />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm text-fg">{toolLabel(tool)}</span>
                          <code className="text-xs text-fg-muted [overflow-wrap:anywhere]">{tool}</code>
                        </span>
                      </label>
                      <span className="text-xs font-medium text-fg-muted">
                        {!live.granted || changes === "off" ? "Off" : CHANGE_WORDS[changes]}
                      </span>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
          </div>
        )}
      </div>
    </details>
  );
}
