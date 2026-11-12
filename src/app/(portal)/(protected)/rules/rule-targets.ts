// The tools and services a rule may name (UI/UX pass, interaction-11). A "Use a specific
// tool" rule matches the exact tool name an agent calls (design §8: `call.tool`), and a "Use
// any tool of a service" rule matches the service's catalogue id (`call.connector`). Typing
// either from memory let a typo through ("totally_made_up_tool" was saved and confirmed as
// enforced while protecting nothing), so the builder now offers the real names as choices and
// the server refuses a name that matches no real tool or service.
//
// The real names, from the same sources the MCP surface is built from:
//   • Warthog's own tools — the core tool registry (`get_context`, `create_task` …), plus its
//     find_tools / call_tool helpers;
//   • each catalogue service's tools — its curated tools (`google-gmail__send` …) or, for a
//     service without curated tools, its general `<id>__request` tool; a service that brings
//     its own tools (provider MCP) is known through the tools cached for the person's own
//     connected account (cached discovery only: this never calls a provider);
//   • services — the catalogue ids.
// What a rule matches on is unchanged: the stored value is exactly the name the engine
// compares. Only the choice is constrained.
//
// The same sources name a rule's tool and service for a PERSON (UI/UX follow-up): `labels`
// resolves a tool to its title (a choice's own label first, so the builder's preview reads
// exactly what the saved rule reads) and a service to its catalogue name. Agent-facing
// sentences never use them, so agents keep reading the exact ids.
//
// A SERVER module over injected values (db, catalogue, the person's DEK): it reads no
// `process.env` and holds no secret, and every query is member-scoped by the given userId.

import { join } from "node:path";

import { loadCatalogue, type CatalogueIndex } from "@/server/connectors/catalogue";
import { GOOGLE_CURATED_TOOLS } from "@/server/connectors/curated/google";
import { MICROSOFT_CURATED_TOOLS } from "@/server/connectors/curated/microsoft";
import { readProviderToolsets } from "@/server/connectors/provider-runtime";
import { REQUEST_TOOL, connectorToolsetFor } from "@/server/connectors/tool-routing";
import { listConnectionsForUser, type Connection } from "@/server/db/connections";
import { processSingleton } from "@/server/seams/process-singleton";
import { createToolRegistry } from "@/server/mcp/tools/registry";
import type { AgentCallPipeline } from "@/server/mcp/pipeline";
import type { Db } from "@/server/db/index";
import { ruleLabelsFromChoices, type RuleTargetGroup } from "@/components/rules/rules-organise";
import type { RuleDisplayLabels } from "@/domain/rules/rules";

// The `<connector>__<tool>` namespace separator (design §6.2).
const NAMESPACE = "__";

// The registry is read only for its tool names and titles; nothing is ever called through it.
const UNCALLABLE: AgentCallPipeline = {
  handleAgentCall() {
    throw new Error("rule targets: the tool registry is read for names only");
  },
} as unknown as AgentCallPipeline;

// Warthog's own tools, in the registry's order, with their plain titles.
function warthogTools(): readonly { name: string; title: string }[] {
  const registry = createToolRegistry({ pipeline: UNCALLABLE });
  const helpers = ["find_tools", "call_tool"].flatMap((name) => {
    const tool = registry.get(name);
    return tool ? [{ name: tool.name, title: tool.title }] : [];
  });
  return [...registry.coreTools.map((tool) => ({ name: tool.name, title: tool.title })), ...helpers];
}

const CURATED = [...GOOGLE_CURATED_TOOLS, ...MICROSOFT_CURATED_TOOLS];

// Every tool name any catalogue service has that is known without a connection: curated
// tools, or the general request tool for a service with none. Provider-MCP services list
// their tools only once connected, so they are added per person.
function staticServiceTools(catalogue: CatalogueIndex): Set<string> {
  const names = new Set<string>();
  for (const entry of catalogue.all()) {
    const curated = CURATED.filter((tool) => tool.connectorId === entry.id);
    if (curated.length) for (const tool of curated) names.add(tool.name);
    else if (entry.auth_kind !== "provider_mcp") names.add(`${entry.id}${NAMESPACE}${REQUEST_TOOL}`);
  }
  return names;
}

// The process catalogue for the page is passed in; this is the fallback when none is (the
// same data files, read without operator configuration — only ids and names are needed).
export function catalogueFromDataFiles(): CatalogueIndex {
  return processSingleton("rules.catalogue", () =>
    loadCatalogue({ dir: join(process.cwd(), "catalogue", "connectors"), isOAuthClientConfigured: () => false }),
  );
}

export interface RuleTargets {
  // The builder's choices: Warthog's tools, then each connected service's tools.
  readonly tools: RuleTargetGroup[];
  // The builder's choices: the person's connected services first, then every other service.
  readonly services: RuleTargetGroup[];
  isTool(name: string): boolean;
  isService(name: string): boolean;
  // How a person reads a rule's tool (its title) and service (its catalogue name). An id
  // that names nothing real resolves to nothing, so the sentence shows the id.
  readonly labels: RuleDisplayLabels;
}

function toolLabel(serviceName: string, declarationName: string, title: string | undefined): string {
  if (title) return title;
  if (declarationName === REQUEST_TOOL) return `${serviceName}: any request`;
  return `${serviceName}: ${declarationName.replace(/_/g, " ")}`;
}

// The label of a catalogue service's tool that is known without a connection (a curated
// tool, or the general request tool), named as the builder would name it once the service
// is connected: the toolset is the one a connected account of the service is served, which
// the catalogue and the curated declarations alone decide. Undefined for anything else.
function offlineToolLabel(catalogue: CatalogueIndex, tool: string): string | undefined {
  const split = tool.indexOf(NAMESPACE);
  if (split <= 0) return undefined;
  const entry = catalogue.get(tool.slice(0, split));
  if (!entry || entry.auth_kind === "provider_mcp") return undefined;
  const verb = tool.slice(split + NAMESPACE.length);
  const served: Connection = { id: entry.id, userId: "", connectorId: entry.id, accountLabel: "", status: "connected", connectedAt: new Date(0) };
  const declaration = (connectorToolsetFor([served], [entry.id], catalogue)[entry.id] ?? []).find(
    (candidate) => (typeof candidate === "string" ? candidate : candidate.name) === verb,
  );
  if (declaration === undefined) return undefined;
  return toolLabel(entry.name, verb, typeof declaration === "string" ? undefined : declaration.title);
}

// The tools and services `userId` may name in a rule, and the checks the rule actions run
// before a rule is stored. Member-scoped: only the person's own connections are read.
export async function ruleTargetsFor(
  db: Db,
  catalogue: CatalogueIndex,
  userId: string,
  dek: Uint8Array,
): Promise<RuleTargets> {
  const own = warthogTools();
  const known = new Set<string>([...own.map((tool) => tool.name), ...staticServiceTools(catalogue)]);

  // The person's connected services, one account each (the first), in the order connected.
  const connections = (await listConnectionsForUser(db, userId)).filter(
    (connection) => connection.status === "connected" && catalogue.get(connection.connectorId) !== undefined,
  );
  const firstPerService: Connection[] = [];
  for (const connection of connections) {
    if (!firstPerService.some((seen) => seen.connectorId === connection.connectorId)) firstPerService.push(connection);
  }
  // A provider's tools are known from every connected account's cached list.
  const providerTools = await readProviderToolsets(db, catalogue, userId, connections, dek);
  for (const connection of connections) {
    for (const tool of providerTools[connection.id] ?? []) known.add(`${connection.connectorId}${NAMESPACE}${tool.name}`);
  }

  const toolset = connectorToolsetFor(
    firstPerService,
    firstPerService.map((connection) => connection.connectorId),
    catalogue,
    {},
    providerTools,
  );
  const serviceGroups: RuleTargetGroup[] = firstPerService.flatMap((connection) => {
    const entry = catalogue.get(connection.connectorId)!;
    const declarations = toolset[entry.id] ?? [];
    if (!declarations.length) return [];
    return [
      {
        label: entry.name,
        choices: declarations.map((declaration) => {
          const name = typeof declaration === "string" ? declaration : declaration.name;
          const title = typeof declaration === "string" ? undefined : declaration.title;
          return { value: `${entry.id}${NAMESPACE}${name}`, label: toolLabel(entry.name, name, title) };
        }),
      },
    ];
  });

  const connectedIds = new Set(firstPerService.map((connection) => connection.connectorId));
  const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "en", { sensitivity: "base" });
  const serviceChoice = (id: string) => ({ value: id, label: catalogue.get(id)!.name });
  const connectedServices = [...connectedIds].map(serviceChoice).sort(byName);
  const otherServices = catalogue
    .all()
    .filter((entry) => !connectedIds.has(entry.id))
    .map((entry) => ({ value: entry.id, label: entry.name }))
    .sort(byName);

  const tools: RuleTargetGroup[] = [
    { label: "Warthog", choices: own.map((tool) => ({ value: tool.name, label: tool.title })) },
    ...serviceGroups,
  ];
  const services: RuleTargetGroup[] = [
    ...(connectedServices.length ? [{ label: "Your connected services", choices: connectedServices }] : []),
    { label: connectedServices.length ? "Other services" : "Services", choices: otherServices },
  ];

  // A tool is named by its choice's label first (so the preview and the saved rule agree),
  // then — for a real tool that isn't a choice — by its provider declaration (another
  // connected account's tools) or the toolset its service is served once connected.
  const choiceLabels = ruleLabelsFromChoices(tools, services);
  const providerLabels = new Map<string, string>();
  for (const connection of connections) {
    const entry = catalogue.get(connection.connectorId)!;
    for (const tool of providerTools[connection.id] ?? []) {
      const name = `${connection.connectorId}${NAMESPACE}${tool.name}`;
      if (!providerLabels.has(name)) providerLabels.set(name, toolLabel(entry.name, tool.name, tool.title));
    }
  }
  const labels: RuleDisplayLabels = {
    toolTitle: (tool) =>
      known.has(tool) ? (choiceLabels.toolTitle?.(tool) ?? providerLabels.get(tool) ?? offlineToolLabel(catalogue, tool)) : undefined,
    serviceName: (service) => choiceLabels.serviceName?.(service) ?? catalogue.get(service)?.name,
  };

  return {
    tools,
    services,
    isTool: (name) => known.has(name),
    isService: (name) => catalogue.get(name) !== undefined,
    labels,
  };
}

// How `userId` reads the tools and services their rules name — the labels the Rules page
// uses — for another screen that shows rule sentences (an agent's workspace). Member-scoped
// like `ruleTargetsFor`: only the person's own connections are read.
export async function ruleDisplayLabelsFor(
  db: Db,
  catalogue: CatalogueIndex,
  userId: string,
  dek: Uint8Array,
): Promise<RuleDisplayLabels> {
  return (await ruleTargetsFor(db, catalogue, userId, dek)).labels;
}
