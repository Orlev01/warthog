// E12-S05 — the single-use approval-link store (design §10 Notifications, brief
// "SMS fallback").
//
// When an approval is still unopened at `created_at + fallback_delay`, the fallback job
// sends ONE SMS and ONE email carrying a single-use link that opens the approval after
// sign-in. That link carries a 256-bit token — a CREDENTIAL — so (project rule: tokens
// and link tokens are stored only as hashes, SHA-256 or HMAC; the design fixes this one
// at a 256-bit value stored as a SHA-256 hash, like every other opaque Warthog token)
// this store keeps only the token's hash, never the raw value. The raw token is returned
// exactly once, to the issuer, for the single message that delivers it; it appears in
// clear nowhere else. Redeeming resolves the token to the one approval it is bound to,
// returns that approval id ONCE, then marks the token used — a second presentation, an
// expired token or an unknown token is rejected.
//
// Unlike the member-scoped stores this one is CREDENTIAL-KEYED (like the oauth access
// keys): a row is addressed by its token hash and bound to one approval id, not a
// `user_id`. The person who clicks the link signs in first; the member-scope check (does
// this approval belong to the session user?) happens a layer up, when the resolved
// approval is loaded through the member-scoped approvals store — not here.
//
// Every statement is parameterized through the `Db` seam (INV-102): the approval id and
// the token's hash travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query — and the raw token
// is hashed before it is bound, so it never reaches the query layer at all. Time enters
// through the injected Clock, never SQL now(), so the ten-minute window is deterministic.
// This module reads no `process.env` and holds no secret — db / clock / random are all
// injected (INV-103), so no ambient env value can land in an issued, stored or redeemed
// link.

import { createHash } from "node:crypto";

import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Db } from "./index";

const MINUTE_MS = 60 * 1000;
const LINK_TTL_MS = 10 * MINUTE_MS; // a single-use link lapses ten minutes after issue
const TOKEN_ENTROPY_BYTES = 32; // 256 bits of entropy (design §10)

// What issueApprovalLink takes: the one approval this single-use link opens.
export interface IssueApprovalLinkInput {
  readonly approvalId: string;
}

// issueApprovalLink draws and hashes a token, so it needs the clock (the issue instant,
// from which the ten-minute expiry is computed) and entropy for the token (INJECTED).
export interface IssueApprovalLinkDeps {
  readonly clock: Clock;
  readonly random: Random;
}

// A freshly issued link as handed back to the ISSUER. The raw token is returned only
// here, for the single message that delivers it; it is written to no column.
export interface IssuedApprovalLink {
  readonly token: string;
  readonly approvalId: string;
  readonly expiresAt: Date | string;
  readonly createdAt: Date | string;
}

// What redeemApprovalLink takes: the raw token the person presents (from the link).
export interface RedeemApprovalLinkInput {
  readonly token: string;
}

// redeemApprovalLink checks the expiry and single-use state, so it needs the clock (the
// redeem instant).
export interface RedeemApprovalLinkDeps {
  readonly clock: Clock;
}

// What redeem reports back — a discriminated union on `ok`. A live, unused, unexpired
// token resolves to its approval; a lapsed token is "expired"; an unknown token, or one
// already used, is "invalid" (the two are indistinguishable to a caller).
export type RedeemLinkResult =
  | { ok: true; approvalId: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired" };

// SHA-256 hex of a value — how the link token is addressed in storage (never the raw
// value), the same contract every opaque Warthog token is stored under.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Draw a 256-bit token from the entropy seam, rendered URL-safe (base64url, no padding)
// so it rides inside a link without escaping. Every issue draws fresh entropy, so every
// token — and therefore every stored hash — is distinct.
function drawToken(random: Random): string {
  return Buffer.from(random.randomBytes(TOKEN_ENTROPY_BYTES)).toString("base64url");
}

// Issue a single-use link for one approval: draw a 256-bit token, store ONLY its SHA-256
// hash with a ten-minute expiry bound to `approvalId`, and return the IssuedApprovalLink
// carrying the RAW token (for the single message that delivers it). The returned value
// is assembled from the inputs (it does not depend on a RETURNING read). The raw token is
// written to no column and returned to no other caller.
export async function issueApprovalLink(
  db: Db,
  input: IssueApprovalLinkInput,
  deps: IssueApprovalLinkDeps,
): Promise<IssuedApprovalLink> {
  const token = drawToken(deps.random);
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);

  await db.query(
    `INSERT INTO approval_links (token_hash, approval_id, created_at, expires_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz)`,
    [sha256Hex(token), input.approvalId, now.toISOString(), expiresAt.toISOString()],
  );

  return {
    token,
    approvalId: input.approvalId,
    expiresAt,
    createdAt: now,
  };
}

// Redeem a presented token. It is matched by its SHA-256 hash (the raw token never
// reaches the query layer): no matching row, or a row already used, is "invalid"; a
// matching row past its ten-minute window is "expired" and is NOT consumed; a matching,
// unexpired, unused row is marked used at the clock's instant and resolves to its
// approval id. The consume is a guarded `used_at IS NULL` UPDATE, so the FIRST redemption
// wins — a concurrent second presentation finds nothing to update and is rejected.
export async function redeemApprovalLink(
  db: Db,
  input: RedeemApprovalLinkInput,
  deps: RedeemApprovalLinkDeps,
): Promise<RedeemLinkResult> {
  const now = deps.clock.now();
  const tokenHash = sha256Hex(input.token);

  const found = await db.query(
    `SELECT approval_id, expires_at, used_at
       FROM approval_links
      WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = found.rows[0];
  if (!row || row.used_at != null) {
    return { ok: false, reason: "invalid" };
  }

  if (new Date(row.expires_at as string | number | Date).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const consumed = await db.query(
    `UPDATE approval_links
        SET used_at = $2::timestamptz
      WHERE token_hash = $1 AND used_at IS NULL
      RETURNING approval_id`,
    [tokenHash, now.toISOString()],
  );
  const consumedRow = consumed.rows[0];
  if (!consumedRow) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, approvalId: consumedRow.approval_id as string };
}
