// E13-S09 — Memory read for the page (list-all + search) (brief "Skills, preferences
// and shared memory": "the person can view, search, edit, re-scope and delete any
// memory"; design §4.1).
//
// ONE owner-scoped list-ALL read for the Memory page: every memory the person holds —
// whatever its scope ('kept' | 'shared') and source agent — each carrying its source
// agent, the time it was saved and its scope; PLUS a search that matches over the
// DECRYPTED content within that same owner-filtered set.
//
// A composition, not a re-implementation: it reuses the already-built, tested storage
// primitive (`listMemoriesForUser`) — it re-runs no SQL and re-implements no
// decryption. A memory's content is PERSONAL CONTENT stored DEK-encrypted by that
// store, so this read decrypts it under the INJECTED per-person `dek`: it holds no key
// and reads no `process.env` (INV-103). Member-scoped by the `userId` the caller
// passes — the session's id, never a client value — so another person's memories are
// never returned; the user id is bound as a parameter by the store (INV-102).
//
// The search decrypts IN THE APP within the already member-filtered set (design §4.1:
// "Search over encrypted fields (memory, activity text) decrypts in the app within the
// already filtered set … — acceptable at v1 scale"), so the search term runs as an
// in-memory string match and never reaches a query at all.

import { listMemoriesForUser } from "../db/memories";
import type { MemoryScope } from "../db/memories";
import type { Db } from "../db/index";

// One of the owner's memories as the Memory page shows it: its id, its decrypted
// content, its source agent (null when the PERSON added it), its scope and the time it
// was saved.
export interface MemoryPageItem {
  readonly id: string;
  readonly content: string; // decrypted under the owner's DEK
  readonly sourceAgentId: string | null; // the agent that saved it; null when the PERSON did
  readonly scope: MemoryScope; // "kept" | "shared"
  readonly createdAt: Date; // the time it was saved
}

// List ALL of `userId`'s memories — any scope, any source — each content DECRYPTED
// under the injected `dek` and carrying its source agent, scope and created time, in the
// canonical (by-created-time) order of the store. Member-scoped by `userId`; the user
// id is bound as a parameter by the store, so another person's memories are never
// returned. A wrong DEK fails the GCM tag inside the store and rejects.
export async function memoriesPageData(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<MemoryPageItem[]> {
  const memories = await listMemoriesForUser(db, userId, dek);
  return memories.map((m) => ({
    id: m.id,
    content: m.content,
    sourceAgentId: m.sourceAgentId,
    scope: m.scope,
    createdAt: m.createdAt,
  }));
}

// The subset of the owner's memories whose DECRYPTED content matches `query`
// (case-insensitive substring), decrypting WITHIN the owner-filtered set. Same shape and
// same member-scoping as the list — never another person's memory. The match runs in the
// app, so `query` never reaches a query and cannot alter any SQL.
export async function searchMemories(
  db: Db,
  userId: string,
  dek: Uint8Array,
  query: string,
): Promise<MemoryPageItem[]> {
  const page = await memoriesPageData(db, userId, dek);
  const needle = query.toLowerCase();
  return page.filter((m) => m.content.toLowerCase().includes(needle));
}
