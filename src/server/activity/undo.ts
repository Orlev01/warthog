// E08-S04 — Undo a reversible action (design §9 "Undo writes a new entry", brief
// "Dispute and undo", constitution principle 14 "Warthog writes the record").
//
// A reversible action can be undone, and the undo is ITSELF a recorded action. For an
// entry whose tool declares a reversal, Warthog RUNS the declared reversal tool
// (`runReversal`, routed through the agent pipeline in production — the same seam
// shape as check_approval's `executeApprovedHold`) and WRITES a NEW activity entry for
// it through the recorder (`./recorder`, E07-S02 / `./writer`, E08-S01). The activity
// record is append-only, so the ORIGINAL entry is NEVER changed — the undo appends a
// new link to the same per-user chain, which still verifies intact afterwards.
//
// An entry whose tool declares no reversal (a read, an approval, a connection change,
// or any tool with no declared reversal) is refused with a plain-words reason, and
// NOTHING is run or recorded. A person can only ever undo their OWN entries: the
// original is read scoped by the SESSION user id (bound as a parameter, INV-102) plus
// the seq, so an entry the caller does not own simply matches no row and is refused —
// the other person's entry is never reached.
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id and
// seq travel as BOUND values, never concatenated into the SQL text, so a value shaped
// like SQL is read as inert data and cannot alter the query. This module reads no
// `process.env` and holds no key (INV-103): the db, recorder, reversal table and
// reversal executor are all INJECTED.

import type { Db } from "../db/index";
import type { ActivityEntry, ActivityRecorder } from "./recorder";

// What the caller asks to undo: the person (the SESSION user id, the member scope),
// the entry's seq within THAT person's chain, and an optional plain reason.
export interface UndoInput {
  readonly userId: string;
  readonly entrySeq: number;
  readonly reason?: string;
}

// The result of an undo: the NEW reversal entry that was recorded, or a refusal with a
// plain-words reason (never a silent failure).
export type UndoResult =
  | { ok: true; entry: ActivityEntry }
  | { ok: false; reason: string };

// The job handed to the reversal executor. The declared reversal tool plus enough
// context to route and record it; the executor effects the reversal (in production,
// through the agent pipeline / connector) and reports its outcome.
export interface UndoReversalJob {
  readonly userId: string;
  readonly reversalTool: string;
  readonly originalSeq: number;
  readonly reason?: string;
}

export interface UndoServiceOptions {
  // Reads the ORIGINAL entry (parameterized, member-scoped).
  db: Db;
  // Writes the NEW reversal entry — Warthog writes the record.
  recorder: ActivityRecorder;
  // The declared reversal tool for a tool name, or undefined when none is declared
  // (the "is this reversible?" decision). A read/approval/connection entry — whose
  // tool is null/undeclared — yields undefined.
  reversalFor: (tool: string | undefined) => string | undefined;
  // Effects the reversal (routes the reversal tool through the agent pipeline /
  // connector in production). Injected so tests never touch a network.
  runReversal: (job: UndoReversalJob) => Promise<{ outcome: string }>;
}

export interface UndoService {
  // Undo the CALLER'S OWN entry at `entrySeq`. If the entry's tool declares a
  // reversal, run it and record a NEW entry whose `tool` is the reversal tool; return
  // { ok: true, entry }. If the entry does not exist for this caller, or its tool
  // declares no reversal, refuse with a plain reason and run/record NOTHING. The
  // original entry is never altered.
  undo(input: UndoInput): Promise<UndoResult>;
}

export function createUndoService(options: UndoServiceOptions): UndoService {
  const { db, recorder, reversalFor, runReversal } = options;

  return {
    async undo(input: UndoInput): Promise<UndoResult> {
      const { userId, entrySeq, reason } = input;

      // Member-scoped read of the CALLER'S OWN entry (user id and seq bound, never a
      // client-concatenated value). An entry the caller does not own has no such row,
      // so one person can never reach another's entry.
      const found = await db.query(
        "SELECT seq, tool FROM activity_entries WHERE user_id = $1 AND seq = $2",
        [userId, entrySeq],
      );
      const row = found.rows[0];
      if (!row) {
        return { ok: false, reason: `There's no activity entry at position ${entrySeq} to undo.` };
      }

      const tool = row.tool == null ? undefined : String(row.tool);
      const reversalTool = reversalFor(tool);
      if (!reversalTool) {
        return { ok: false, reason: "This action can't be undone — it has no reversal." };
      }

      // Run the declared reversal, then WRITE a NEW entry for it. The original entry
      // is never touched; the record is append-only (design §9).
      const reversal = await runReversal({ userId, reversalTool, originalSeq: entrySeq, reason });

      const entry = await recorder.record({
        userId,
        kind: "tool_call",
        source: "warthog",
        tool: reversalTool,
        outcome: reversal.outcome,
        payload: {
          undoneSeq: entrySeq,
          reversalTool,
          outcome: reversal.outcome,
          ...(reason !== undefined ? { reason } : {}),
        },
      });

      return { ok: true, entry };
    },
  };
}
