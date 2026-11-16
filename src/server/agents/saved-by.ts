// Write provenance — who saved a memory or created a task, as agents read it
// (docs/adr/read-side-protection.md "Later in this series": saved-by labels).
//
// Shared memories and tasks reach other agents. A note an agent saved after reading
// someone's email is still that agent's note, not the person's wish, so every memory and
// task an agent reads says who saved it: "you" (this agent), "person" (the person, in the
// portal), or another agent by its name. The kind is structured, so an agent named
// "the person" can never pass as the person.

import { listAgentsForUser } from "../db/agents";
import type { Db } from "../db/index";
import { cleanShortText } from "../../domain/content/untrusted";

export type SavedBy = { readonly kind: "you" } | { readonly kind: "person" } | { readonly kind: "agent"; readonly name: string };

/** A resolver from a saver's agent id (null = the person) to how the reading agent sees it. */
export type SavedByResolver = (sourceAgentId: string | null | undefined) => SavedBy;

const FORMER_AGENT = "an agent that is no longer connected";

/** Resolve savers for one reading agent, with one member-scoped read of the person's agents. */
export async function savedByResolver(db: Db, userId: string, readingAgentId: string): Promise<SavedByResolver> {
  const names = new Map<string, string>();
  for (const agent of await listAgentsForUser(db, userId)) names.set(agent.id, cleanShortText(agent.displayName, 80));
  return (sourceAgentId) => {
    if (!sourceAgentId) return { kind: "person" };
    if (sourceAgentId === readingAgentId) return { kind: "you" };
    return { kind: "agent", name: names.get(sourceAgentId) ?? FORMER_AGENT };
  };
}
