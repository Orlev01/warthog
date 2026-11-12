// The activity-type and outcome-group rules (`domain/activity/category`) as SQL CASE
// expressions over the plaintext metadata columns, so the Activity views can filter, page
// and count by type over a person's whole record without decrypting a single payload.
//
// Parameterized (INV-102): every kind/tool list travels as a BOUND text[] value
// (`= ANY($n::text[])`); the statement text carries only fixed column names and the fixed
// category/outcome-group labels. Built from the same lists as the TypeScript classifier,
// and tested row-for-row against it, so the two can never disagree.

import {
  ACCESS_KINDS,
  ACCOUNT_KINDS,
  APPROVAL_KINDS,
  APPROVAL_TOOLS,
  OUTCOME_CODES,
  REJECTED_KINDS,
  REPORT_KINDS,
  REPORT_TOOLS,
  TOOL_KINDS,
} from "@/domain/activity/category";
import { READ_ONLY_TOOLS } from "./tool-effects";

// Push a value onto the statement's bound values and return its placeholder.
export type Bind = (value: unknown) => string;

export function categoryCaseSql(bind: Bind): string {
  const toolKinds = `${bind(TOOL_KINDS)}::text[]`;
  return `CASE
    WHEN source = 'agent_reported' OR kind = ANY(${bind(REPORT_KINDS)}::text[]) THEN 'report'
    WHEN kind = ANY(${toolKinds}) AND tool = ANY(${bind(REPORT_TOOLS)}::text[]) THEN 'report'
    WHEN kind = ANY(${bind(APPROVAL_KINDS)}::text[]) THEN 'approval'
    WHEN kind = ANY(${toolKinds}) AND tool = ANY(${bind(APPROVAL_TOOLS)}::text[]) THEN 'approval'
    WHEN kind = ANY(${bind(REJECTED_KINDS)}::text[]) THEN 'rejected'
    WHEN kind = ANY(${bind(ACCESS_KINDS)}::text[]) THEN 'access'
    WHEN kind = ANY(${bind(ACCOUNT_KINDS)}::text[]) THEN 'account'
    WHEN kind = ANY(${toolKinds}) AND tool = ANY(${bind(READ_ONLY_TOOLS)}::text[]) THEN 'read'
    WHEN kind = ANY(${toolKinds}) THEN 'change'
    ELSE 'other' END`;
}

export function outcomeGroupCaseSql(bind: Bind): string {
  return `CASE
    WHEN outcome = ANY(${bind(OUTCOME_CODES.done)}::text[]) THEN 'done'
    WHEN outcome = ANY(${bind(OUTCOME_CODES.waiting)}::text[]) THEN 'waiting'
    WHEN outcome = ANY(${bind(OUTCOME_CODES.blocked)}::text[]) THEN 'blocked'
    WHEN outcome = ANY(${bind(OUTCOME_CODES.failed)}::text[]) THEN 'failed'
    ELSE 'other' END`;
}

// Whether an activity_entries row (unaliased) has at least one dispute, matched on BOTH the
// owner and the entry position so one person's dispute never marks another's entry.
export const DISPUTED_SQL =
  "EXISTS (SELECT 1 FROM activity_disputes d WHERE d.user_id = activity_entries.user_id AND d.entry_seq = activity_entries.seq)";

// Whether an activity_entries row (unaliased) has been undone, or has an undo in progress
// (`activity_undo_claims`, 13 Nov), matched on BOTH the owner and the entry position so one
// person's undo never marks another's entry.
export const UNDO_CLAIMED_SQL =
  "EXISTS (SELECT 1 FROM activity_undo_claims u WHERE u.user_id = activity_entries.user_id AND u.entry_seq = activity_entries.seq)";
