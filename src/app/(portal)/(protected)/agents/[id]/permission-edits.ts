// Gather the permissions screen's edits from its rendered controls (operator fix for the E10-S08
// review veto). Every control the screen renders is carried with its explicit on/off state, and a
// control the form cannot find REFUSES the save — naming what is missing — instead of silently
// omitting that field and reporting "Saved" over a dropped edit. Pure, so it is unit-tested
// without a DOM; the form maps its <input>s to ControlSnapshots.
//
// Review fix W2.3: controls are found by their stable `name` attribute (the view names every
// input), never by matching visible label text — so a connected service or skill whose name
// contains "card" or "learn" can never stand in for the card-access or sharing toggle, and a copy
// change cannot break saving. The screen's tasks and records grants are carried the same way.
//
// The Connectors section has one row per connected ACCOUNT (docs/adr/several-accounts-per-agent.md),
// each with its own toggle, reading and changes choices and tool ticks, all named by the account's
// id (ACCOUNT_CONTROL). Every row the screen shows is carried, ticked or not; "Same as this
// agent's setting" leaves that setting out, so the account follows the agent's own.
import { ACCOUNT_CONTROL, type PermissionsSection } from "@/domain/permissions/workspace";
import type { PeriodKind } from "@/domain/budget/budget";
import type { PermissionsSaveInput } from "./actions";

export type ControlSnapshot = {
  readonly type: string; // the input's type: "checkbox" | "number" | …
  readonly name: string; // its stable `name` attribute (e.g. "card", "account:<account id>")
  readonly label?: string; // its accessible name, for diagnostics only — never matched on
  readonly checked: boolean;
  readonly value: string;
};

export type CollectResult =
  | { readonly ok: true; readonly input: PermissionsSaveInput }
  | { readonly ok: false; readonly reason: "form_incomplete"; readonly missing: readonly string[] };

// The toggles the screen always renders, by the save field each one feeds (field = input name).
const REQUEST_LIMIT = "requestLimit";
const CARD_BUDGET = "cardBudget";

export function collectEdits(
  controls: readonly ControlSnapshot[],
  // `accounts`: the ids of the connected accounts the Connectors section shows, one row each.
  opts: { readonly currency: string; readonly period: PeriodKind; readonly accounts: readonly string[]; readonly skills?: readonly string[]; readonly memories?:readonly string[]; readonly vaultFields?:readonly string[]; readonly section?: PermissionsSection },
): CollectResult {
  const find = (type: string, name: string) => controls.find((c) => c.type === type && c.name === name);

  const section = opts.section ?? "all";
  const includes = (part: PermissionsSection) => section === "all" || section === part;
  const names: string[] = [
    ...(includes("vault") ? ["identity", "highTier"] : []),
    ...(includes("spending") ? ["card"] : []),
    ...(includes("settings") ? ["tasks", "records"] : []),
    ...(includes("memory") ? ["memoryRead", "learningSharing", ...(opts.section ? ["memoryWrite"] : [])] : []),
    ...(includes("connectors") && opts.section ? ["readTools"] : []),
  ];
  const missing = names.filter(name => !find("checkbox", name));
  if (includes("settings") && !find("number", REQUEST_LIMIT)) missing.push(REQUEST_LIMIT);
  const accountIds = includes("connectors") ? opts.accounts : [];
  const skillIds = includes("skills") ? opts.skills ?? [] : [];
  const memoryIds=includes("memory") ? opts.memories ?? [] : [];
  const vaultIds=includes("vault") && controls.find(c=>c.name==="identityScope")?.value==="chosen" ? opts.vaultFields ?? [] : [];
  for (const name of [...accountIds.map(ACCOUNT_CONTROL.granted), ...skillIds.map(id => `skill:${id}`), ...memoryIds.map(id=>`memory:${id}`), ...vaultIds.map(id=>`vaultField:${id}`)]) {
    if (!find("checkbox", name)) missing.push(name);
  }
  // Each account row's own settings: one missing would otherwise reset that account to the
  // agent's setting without the person choosing it.
  for (const id of accountIds) {
    for (const name of [ACCOUNT_CONTROL.read(id), ACCOUNT_CONTROL.change(id), ACCOUNT_CONTROL.toolScope(id)]) {
      if (!controls.some(c => c.name === name)) missing.push(name);
    }
  }
  const changes = controls.find(c => c.name === "changeTools");
  if (includes("connectors") && opts.section && !changes) missing.push("changeTools");
  if (missing.length) return { ok: false, reason: "form_incomplete", missing };
  const input: PermissionsSaveInput = {};
  for (const name of names) Object.assign(input, { [name]: find("checkbox", name)!.checked });
  if (includes("settings")) {
    const tasksWrite = find("checkbox", "tasksWrite"), recordsWrite = find("checkbox", "recordsWrite");
    const recordScope = controls.find(c => c.name === "recordScope")?.value;
    if (tasksWrite || recordsWrite || recordScope) input.resourceControls = {
      ...(tasksWrite ? {tasksWrite: tasksWrite.checked}:{}), ...(recordsWrite ? {recordsWrite: recordsWrite.checked}:{}),
      ...(recordScope ? {recordIds: recordScope === "chosen" ? controls.filter(c => c.name.startsWith("record:") && c.checked).map(c => c.name.slice(7)) : null}:{}),
    };
  }
  if (includes("connectors")) {
    input.accounts = accountIds.map(id => accountEdit(controls, id));
    if (changes) input.changeTools = changes.value as PermissionsSaveInput["changeTools"];
  }
  if (includes("skills") && opts.skills) input.skills = skillIds.map(id => ({ id, granted: find("checkbox", `skill:${id}`)!.checked }));
  // Whether it may save skills for the person to check (docs/adr/agent-saved-skills.md).
  const skillsWrite = includes("skills") ? find("checkbox", "skillsWrite") : undefined;
  if (skillsWrite) input.resourceControls = { ...input.resourceControls, skillsWrite: skillsWrite.checked };
  if(includes("memory") && opts.memories) input.memories=memoryIds.map(id=>({id,granted:find("checkbox",`memory:${id}`)!.checked}));
  const identityScope=controls.find(c=>c.name==="identityScope");
  if(includes("vault") && identityScope) input.identityFields=identityScope.value==="all"?null:vaultIds.filter(id=>find("checkbox",`vaultField:${id}`)!.checked);
  const limit = includes("settings") ? find("number", REQUEST_LIMIT)?.value.trim() : undefined;
  if (limit) input.requestLimit = Number(limit);
  const budget = find("number", CARD_BUDGET);
  if (input.card && budget && budget.value.trim() !== "") {
    input.cardBudget = { amount: Number(budget.value), currency: controls.find(c => c.name === "cardBudgetCurrency")?.value ?? opts.currency, period: (controls.find(c => c.name === "cardBudgetPeriod")?.value ?? opts.period) as PeriodKind };
  }
  return { ok: true, input };
}

// One account row as the save sends it: whether the agent may use the account, and each of its
// own settings the person chose ("Same as this agent's setting" and "All tools" leave theirs out).
function accountEdit(controls: readonly ControlSnapshot[], id: string): NonNullable<PermissionsSaveInput["accounts"]>[number] {
  const value = (name: string) => controls.find(c => c.name === name)?.value;
  const read = value(ACCOUNT_CONTROL.read(id));
  const change = value(ACCOUNT_CONTROL.change(id));
  const scope = value(ACCOUNT_CONTROL.toolScope(id));
  return {
    id,
    granted: controls.find(c => c.type === "checkbox" && c.name === ACCOUNT_CONTROL.granted(id))!.checked,
    ...(read === "on" || read === "off" ? { readTools: read === "on" } : {}),
    ...(change === "off" || change === "ask_first" || change === "allow" ? { changeTools: change } : {}),
    ...(scope === "chosen" ? { allowedTools: controls.filter(c => c.name === ACCOUNT_CONTROL.tool(id) && c.checked).map(c => c.value) } : {}),
  };
}
