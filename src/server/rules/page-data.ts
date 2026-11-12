// E12-S15 — the Rules page read (design §8, brief "Rules and approvals"). The Rules
// page needs ONE owner-scoped list-ALL read: every rule the person has written —
// ACTIVE and PAUSED — each rendered back to its exact plain-English sentence with its
// scope (all agents or a chosen agent) and lifecycle status. It is DISTINCT from the
// policy engine's `listRules` / `applicableRules` (active-only, for enforcement): the
// page must also show the paused ones so the person can see and resume them.
//
// It composes the already-built, tested storage primitive (`listAllRules`) rather than
// re-running SQL or re-implementing decryption, and the existing pure renderer
// (`ruleSentence`) rather than hard-coding wording. The read is member-scoped by the
// `userId` the caller passes (the session's id, never a client value) and binds that id
// as a parameter (INV-102) — so no person can read another's rules and a value shaped
// like SQL travels as data, not statement text.
//
// This module reads no `process.env` and holds no key (INV-103): a rule's `condition` is
// personal content decrypted only under the INJECTED `dek`, so a different DEK cannot
// read it back.

import { listAllRules } from "../db/rules";
import { ruleSentence, type RuleKind, type RuleScope } from "../../domain/rules/rules";
import type { Db } from "../db/index";

// One rule as the Rules page shows it: its id, its exact English sentence, its scope
// (all agents or the chosen agent's id + name), its kind (shown as a word badge) and its
// lifecycle status (so paused rules are distinguishable in the UI).
export interface RulesPageItem {
  readonly id: string;
  readonly sentence: string;
  readonly scope: RuleScope;
  readonly kind: RuleKind;
  readonly status: "active" | "paused";
}

// List ALL of `userId`'s rules — ACTIVE and PAUSED — each rendered as its plain English
// sentence (its DEK-encrypted condition decrypted under the injected `dek` first),
// carrying its scope and lifecycle status. Member-scoped by the passed `userId` alone:
// another person's rules are never returned.
//
// `agentNames` (optional; the caller's OWN agents' names keyed by connection id) names a
// chosen-agent scope by the agent's CURRENT name before the sentence is rendered, so a
// scope stored under a raw connection id or an old name reads back naming the agent
// (review fix W2.1). A scope whose agent is not in it keeps its stored name.
export async function rulesPageData(
  db: Db,
  userId: string,
  dek: Uint8Array,
  agentNames?: ReadonlyMap<string, string>,
): Promise<RulesPageItem[]> {
  const rules = await listAllRules(db, userId, dek);
  return rules.map((rule) => {
    const scope = namedScope(rule.scope, agentNames);
    return {
      id: rule.id,
      sentence: ruleSentence({ ...rule, scope }),
      scope,
      kind: rule.kind,
      status: rule.status,
    };
  });
}

// A chosen-agent scope named by its agent's current name, when `agentNames` knows it.
function namedScope(scope: RuleScope, agentNames: ReadonlyMap<string, string> | undefined): RuleScope {
  if (scope.type !== "agent") return scope;
  const name = agentNames?.get(scope.agentId);
  return name === undefined ? scope : { ...scope, name };
}
