// E15-S05 — the single-use household-invite store (brief "Household sharing"; design
// §4.1).
//
// The owner invites members by an emailed link valid 7 days (up to 8 members, the cap
// shared with E15-S04's household store). That link carries a 256-bit token — a
// CREDENTIAL — so (project rule: tokens and link tokens are stored only as hashes,
// SHA-256 or HMAC; the design fixes this one at a 256-bit value stored as a SHA-256 hash,
// like every other opaque Warthog token) this store keeps only the token's hash, never
// the raw value. The raw token is returned exactly once, to the issuer, for the single
// message (the emailed link) that delivers it; it appears in clear nowhere else. Redeeming
// resolves the token to the ONE household it is bound to and ADDS the redeeming, signed-in
// person as a member (within the 8-member cap), then marks the token used — a second
// presentation, an expired token or an unknown token is rejected. The invite is bound to
// the invited EMAIL: only the account with that (verified) email can redeem it, and only
// while it belongs to no other household — a person belongs to one household.
//
// Like the approval-link store (E12-S05) this one is CREDENTIAL-KEYED: a row is addressed
// by its token hash and bound to one household + the invited email, not a `user_id`. The
// person who clicks the link signs in first; the user ADDED on redemption is the SESSION's
// user id (passed by the caller), never a value smuggled from the client. The owner-only
// authorisation to ISSUE an invite is enforced a layer up — this store's job is the token
// lifecycle, so it takes `householdId` + `email` and never re-checks owner-ness here.
//
// Every invite sends an email, so issuing is bounded (review fix W3.1): a household's OPEN
// invites (unused and unexpired) never exceed its free places (8 − current members), a new
// invite to an address replaces that address's earlier open invite (a resend takes no extra
// place), and a household sends at most INVITES_PER_HOUR invites in any hour. Both checks
// and the insert are one statement, run under the household row lock addMember also takes,
// so parallel invites (or an invite racing a join) can never overshoot either limit.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and the email
// travel as BOUND values, never concatenated into the SQL text, so a value shaped like SQL
// is stored as data and cannot alter the query — and the raw token is hashed before it is
// bound, so it never reaches the query layer at all. Time enters through the injected
// Clock, never SQL now(), so the seven-day window is deterministic. This module reads no
// `process.env` and holds no secret — db / clock / random are all injected (INV-103), so no
// ambient env value can land in an issued, stored or redeemed invite.

import { createHash } from "node:crypto";

import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Db } from "./index";
import { withTransaction } from "./index";
import { addMember, MAX_MEMBERS } from "./households";

const DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * DAY_MS; // an invite link lapses seven days after issue (brief)
const TOKEN_ENTROPY_BYTES = 32; // 256 bits of entropy (design §4.1)
const HOUR_MS = 60 * 60 * 1000;

// How many invites one household may send in any rolling hour (resends included). Enough to
// invite everyone at once (at most seven places) and resend a couple; not enough to use the
// household as a mailer.
export const INVITES_PER_HOUR = 10;

// Why an invite was not issued: the household has no free place left for another open
// invite ("no_room"), or it has sent INVITES_PER_HOUR invites in the last hour
// ("throttled"). Thrown by issueInvite; nothing is stored and nothing should be sent.
export type IssueRefusal = "no_room" | "throttled";

export class InviteRefusedError extends Error {
  constructor(readonly reason: IssueRefusal) {
    super(reason === "no_room" ? "The household has no free place for another invite" : "Too many invites this hour");
    this.name = "InviteRefusedError";
  }
}

// What issueInvite takes: the household this invite joins (bound to ONE) and the invited
// person's email (bound to the invite).
export interface IssueInviteInput {
  readonly householdId: string;
  readonly email: string;
}

// issueInvite draws and hashes a token, so it needs the clock (the issue instant, from
// which the seven-day expiry is computed) and entropy for the token (INJECTED).
export interface IssueInviteDeps {
  readonly clock: Clock;
  readonly random: Random;
}

// A freshly issued invite as handed back to the ISSUER. The raw token is returned only
// here, for the single message that delivers it; it is written to no column.
export interface IssuedInvite {
  readonly token: string;
  readonly householdId: string;
  readonly email: string;
  readonly expiresAt: Date | string;
  readonly createdAt: Date | string;
}

// What redeemInvite takes: the raw token the person presents (from the link in the
// message) and the SIGNED-IN user redeeming it — added as a member (the session id).
export interface RedeemInviteInput {
  readonly token: string;
  readonly userId: string;
}

// redeemInvite checks the expiry and single-use state, so it needs the clock (the redeem
// instant).
export interface RedeemInviteDeps {
  readonly clock: Clock;
}

// What redeem reports back — a discriminated union on `ok`. A live, unused, unexpired
// token adds the user and resolves to its household; a lapsed token is "expired"; an
// unknown token, or one already used, is "invalid" (the two are indistinguishable); a
// token presented by an account whose email is not the invited one is "wrong_account"; a
// person who already belongs to another household is "already_in_household"; a
// redemption that would exceed the 8-member cap is "household_full". Every refusal adds
// no member and leaves the invite usable (except "invalid", where there is none).
export type RedeemInviteResult =
  | { ok: true; householdId: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "wrong_account" }
  | { ok: false; reason: "already_in_household" }
  | { ok: false; reason: "household_full" };

// The refusals a presented token can meet before anyone is added.
type InviteRefusal = Extract<RedeemInviteResult, { ok: false }>;

// SHA-256 hex of a value — how the invite token is addressed in storage (never the raw
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

// Issue an invite for one household + email: draw a 256-bit token, store ONLY its SHA-256
// hash with a seven-day expiry bound to `householdId` + `email`, and return the
// IssuedInvite carrying the RAW token (for the single message that delivers it). The
// returned value is assembled from the inputs. The raw token is written to no column and
// returned to no other caller.
//
// The insert happens only while the household is under both limits (see the header): the
// open invites to OTHER addresses plus the current members stay under 8, and fewer than
// INVITES_PER_HOUR invites were sent in the hour before now. Otherwise nothing is stored
// and InviteRefusedError names the limit. A successful invite retires the address's earlier
// open invite (its expiry becomes now, so that link reads as expired).
export async function issueInvite(
  db: Db,
  input: IssueInviteInput,
  deps: IssueInviteDeps,
): Promise<IssuedInvite> {
  const token = drawToken(deps.random);
  const tokenHash = sha256Hex(token);
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const hourAgo = new Date(now.getTime() - HOUR_MS);

  const refusal = await withTransaction(db, async (tx): Promise<IssueRefusal | null> => {
    // The same household lock addMember takes, so invites and joins serialise on Postgres;
    // the gated insert below re-checks both limits in one statement either way.
    await tx.query("SELECT 1 FROM households WHERE id = $1 FOR UPDATE", [input.householdId]);
    const inserted = await tx.query(
      `INSERT INTO household_invites (token_hash, household_id, email, created_at, expires_at)
       SELECT $1, $2, $3, $4::timestamptz, $5::timestamptz
        WHERE (SELECT count(*) FROM household_invites
                WHERE household_id = $2 AND created_at > $6::timestamptz) < $7::int
          AND (SELECT count(*) FROM household_invites
                WHERE household_id = $2 AND used_at IS NULL AND expires_at > $4::timestamptz
                  AND lower(btrim(email)) <> lower(btrim($3)))
            + (SELECT count(*) FROM household_members WHERE household_id = $2) < $8::int
       RETURNING token_hash`,
      [
        tokenHash,
        input.householdId,
        input.email,
        now.toISOString(),
        expiresAt.toISOString(),
        hourAgo.toISOString(),
        INVITES_PER_HOUR,
        MAX_MEMBERS,
      ],
    );
    if (inserted.rows.length === 0) {
      // Nothing was stored: name the limit that refused it.
      const sent = await tx.query(
        `SELECT count(*)::int AS n FROM household_invites
          WHERE household_id = $1 AND created_at > $2::timestamptz`,
        [input.householdId, hourAgo.toISOString()],
      );
      return Number(sent.rows[0]?.n ?? 0) >= INVITES_PER_HOUR ? "throttled" : "no_room";
    }
    // A resend: the address's earlier open invite stops working now.
    await tx.query(
      `UPDATE household_invites SET expires_at = $3::timestamptz
        WHERE household_id = $1 AND token_hash <> $2 AND used_at IS NULL
          AND expires_at > $3::timestamptz AND lower(btrim(email)) = lower(btrim($4))`,
      [input.householdId, tokenHash, now.toISOString(), input.email],
    );
    return null;
  });
  if (refusal) throw new InviteRefusedError(refusal);

  return {
    token,
    householdId: input.householdId,
    email: input.email,
    expiresAt,
    createdAt: now,
  };
}

// A still-open invite as surfaced to the Household page: the invited EMAIL the owner typed
// and the invite's expiry. The row's `token_hash` (its credential-derived key) is never
// selected, so no token or token hash leaves the server — only the email + expiry.
export interface PendingInvite {
  readonly email: string;
  readonly expiresAt: Date | string;
}

// List a household's STILL-OPEN invites — unused (`used_at IS NULL`) AND not yet expired at
// `clock.now()` (`expires_at > now`, the same boundary redeemInvite treats as expired) —
// by email + expiry only. Member-scoped by the bound `userId`: the EXISTS gate means only a
// member of that household reads its invites, so a non-member (or a stranger) reads []. The
// household id, the user id and the instant all travel as BOUND values (INV-102), and the
// token hash is never selected, so no credential is exposed. Time enters through the injected
// Clock, never SQL now().
export async function listPendingInvites(
  db: Db,
  input: { householdId: string; userId: string },
  deps: { clock: Clock },
): Promise<PendingInvite[]> {
  const now = deps.clock.now();
  const result = await db.query(
    `SELECT i.email, i.expires_at
       FROM household_invites i
      WHERE i.household_id = $1
        AND i.used_at IS NULL
        AND i.expires_at > $3::timestamptz
        AND EXISTS (
          SELECT 1 FROM household_members m
           WHERE m.household_id = $1 AND m.user_id = $2
        )`,
    [input.householdId, input.userId, now.toISOString()],
  );
  return result.rows.map((row) => ({
    email: String(row.email),
    expiresAt: row.expires_at as Date | string,
  }));
}

// Check a presented token for `userId` WITHOUT consuming it or adding anyone: the
// household it would join, or why it would be refused. The checks, in order: the token
// exists and is unused ("invalid"), is inside its seven-day window ("expired"), was sent
// to THIS account's email ("wrong_account" — compared case- and space-insensitively; the
// account email is the one verified at sign-up, so a forwarded or leaked link cannot
// enrol someone else), and the person is in no other household ("already_in_household").
// The capacity check happens on the add itself (`addMember`), never here, so a preview
// never promises a place that a concurrent join then takes.
async function checkInvite(
  db: Db,
  tokenHash: string,
  userId: string,
  now: Date,
): Promise<{ ok: true; householdId: string } | InviteRefusal> {
  const found = await db.query(
    `SELECT i.household_id, i.expires_at, i.used_at,
            lower(btrim(i.email)) = lower(btrim(u.email)) AS email_matches
       FROM household_invites i
       LEFT JOIN users u ON u.id = $2
      WHERE i.token_hash = $1`,
    [tokenHash, userId],
  );
  const row = found.rows[0];
  if (!row || row.used_at != null) {
    return { ok: false, reason: "invalid" };
  }
  if (new Date(row.expires_at as string | number | Date).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (row.email_matches !== true) {
    return { ok: false, reason: "wrong_account" };
  }
  const householdId = String(row.household_id);
  const elsewhere = await db.query(
    "SELECT 1 FROM household_members WHERE user_id = $1 AND household_id <> $2",
    [userId, householdId],
  );
  if (elsewhere.rows.length > 0) {
    return { ok: false, reason: "already_in_household" };
  }
  return { ok: true, householdId };
}

// What a presented token WOULD do for the signed-in `userId`, without consuming it or
// adding anyone — the join confirmation screen's read, so a person is shown a refusal
// before they confirm rather than after. Same outcomes and checks as redeemInvite, except
// that a full household is only discovered on the redeem itself.
export async function previewInvite(
  db: Db,
  input: RedeemInviteInput,
  deps: RedeemInviteDeps,
): Promise<RedeemInviteResult> {
  return checkInvite(db, sha256Hex(input.token), input.userId, deps.clock.now());
}

// Redeem a presented token. It is matched by its SHA-256 hash (the raw token never reaches
// the query layer) and checked exactly as `checkInvite` describes; a token that passes adds
// `userId` to the bound household and marks the token used, in one transaction so the
// member-add and the single-use consume commit together. Adding is cap- and
// one-household-checked atomically BEFORE the token is consumed (`addMember` locks the
// household row and re-checks in its insert), so a full household is refused with
// "household_full", two parallel joins can never overfill it, and a refusal leaves the
// invite intact. The consume is a guarded `used_at IS NULL` UPDATE, so the FIRST
// redemption wins — a second presentation finds the row already used and is rejected.
export async function redeemInvite(
  db: Db,
  input: RedeemInviteInput,
  deps: RedeemInviteDeps,
): Promise<RedeemInviteResult> {
  const now = deps.clock.now();
  const tokenHash = sha256Hex(input.token);

  return withTransaction(db, async (tx): Promise<RedeemInviteResult> => {
    const checked = await checkInvite(tx, tokenHash, input.userId, now);
    if (!checked.ok) return checked;
    const { householdId } = checked;

    // Enforce the shared 8-member cap and the one-household rule BEFORE consuming the
    // token, so a refusal adds no member and leaves the invite intact. Already being a
    // member of THIS household is not a refusal: the token is simply spent.
    const added = await addMember(tx, { householdId, userId: input.userId });
    if (!added.ok && added.reason !== "already_member") {
      return { ok: false, reason: added.reason };
    }

    // Claim the token exactly once: the guarded UPDATE lets only the first redemption win.
    const consumed = await tx.query(
      `UPDATE household_invites
          SET used_at = $2::timestamptz
        WHERE token_hash = $1 AND used_at IS NULL
        RETURNING household_id`,
      [tokenHash, now.toISOString()],
    );
    if (!consumed.rows[0]) {
      return { ok: false, reason: "invalid" };
    }

    return { ok: true, householdId };
  });
}
