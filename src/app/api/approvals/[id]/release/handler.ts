// E11-S10 — Approval release endpoint: the injectable sibling handler (design §4.2
// "Release" + the in-memory release store; §4.3 the released-value fingerprint; §5
// step-up; brief "release — one-time hand-over of a high-tier value or card").
// INV-101 admin-auth-required, INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env.
//
// "Approve and release" is ONE step on the person's device: after a fresh step-up the
// browser decrypts the high-tier value / card detail with the vault key (E11-S07..S09)
// and POSTs the PLAINTEXT to `/api/approvals/[id]/release`. This endpoint is the server
// half of that step. It:
//   1. checks the request's `Origin` against the configured public origin and requires
//      a JSON body (design §5: every route checks Origin) — otherwise nothing happens;
//   2. requires a server-verified session (INV-101) AND a step-up within the last 5
//      minutes (design §5) — otherwise it releases nothing;
//   3. shape-guards the approval id (a non-UUID is a 4xx before `WHERE id = $1`,
//      never a raw cast / 500 — OBS-049, INV-102);
//   4. loads the approval MEMBER-SCOPED by the session user; it must be a card or
//      high-tier RELEASE that is pending or approved and not yet released — else a 4xx
//      (another user's approval, a routine held call, a denied / expired one, or one
//      already released is never releasable);
//   5. re-resolves the requesting agent (member-scoped) — it must still be connected
//      and still allowed the access (card / high-tier) — so a value is never planted
//      for a revoked agent;
//   6. validates the body `{ value }` (malformed / oversized / mis-shaped → a 4xx,
//      never a 500 — INV-102);
//   7. in ONE transaction: approves a pending approval (the store's compare-and-swap),
//      marks it released exactly once, for a card re-checks the agent's budget (with
//      the agent row locked, so approvals made before any release cannot together
//      overspend it) and records the spend in the ledger, and persists a keyed one-way
//      HMAC FINGERPRINT of the value for 90 days — NEVER writing the value itself to
//      the database, a log or a metric;
//   8. then puts the value in the process-wide in-memory release store under the
//      requesting agent's REAL connection (`releaseKeyFor`, the SAME key the agent's
//      `collect_release` reads), for its single collection.
//
// A Next App-Router `route.ts` may export ONLY the known route keys (OBS-025), so the
// injectable factory lives HERE; `route.ts` imports it and exports only `POST`. Every
// seam is optional with a production default, resolved LAZILY per request (never at
// construction / import), so importing the entry boots no database and `next build`
// evaluates no runtime config. The handler reads no `process.env` directly — config
// flows through the injected seams, or in production through `loadConfig()` /
// `getServerDb()` at request time (INV-103).

import { z } from "zod";

import { parseBody, HttpError } from "../../../../../server/http/validate";
import { loadConfig } from "../../../../../server/config";
import { getServerDb } from "../../../../../server/db/server";
import {
  verifySession,
  COOKIE_NAME,
  type Session,
} from "../../../../../server/auth/session";
import { requireStepUp } from "../../../../../server/auth/step-up";
import {
  ApprovalAlreadyDecidedError,
  decide,
  getApproval,
  markReleased,
  type StoredApproval,
} from "../../../../../server/db/approvals";
import { getAgentById } from "../../../../../server/db/agents";
import { getConnectionPermissions } from "../../../../../server/db/agent-permissions";
import { periodKeyFor, recordRelease, sumForConnectionPeriod } from "../../../../../server/db/card-spend-ledger";
import { getHouseholdForMember } from "../../../../../server/db/households";
import { getUserById } from "../../../../../server/db/users";
import { storeFingerprint } from "../../../../../server/db/release-fingerprints";
import { timeZoneFor } from "../../../../../server/spending/time-zone";
import { withTransaction } from "../../../../../server/db/index";
import { isReleaseRequest } from "../../../../../domain/approvals/release-kind";
import { createRedactingRecorder } from "../../../../../server/mcp/recorder";
import { fingerprint } from "../../../../../server/crypto/hmac";
import { releaseStore, type ReleaseStore } from "../../../../../server/crypto/release-store";
import { selectKeyWrapper, type KeyWrapper } from "../../../../../server/crypto/key-wrapper";
import { releaseKeyFor } from "../../../../../server/mcp/tools/collect-release";
import { systemClock, type Clock } from "../../../../../server/seams/clock";
import type { Db } from "../../../../../server/db/index";

// A released value is small (a high-tier identity field or card detail), so cap it
// tightly: an oversized value is a bad request before anything is read or released
// (INV-102). The raw body is bounded well below that so a grossly oversized post is
// refused at the byte boundary, never buffered whole.
const MAX_VALUE_CHARS = 4096;
const MAX_BODY_BYTES = 16 * 1024;

// The browser posts just the decrypted `{ value }`; the approval id rides in the path,
// never the body. A non-string / empty / oversized value is a 4xx, never a 500.
const bodySchema = z.object({
  value: z.string().min(1).max(MAX_VALUE_CHARS),
});

// Every approval id is a UUID (`approvals.id` is uuid-typed, created with
// `randomUUID`). A well-formed-but-non-UUID id — including a SQL-injection probe — is
// shape-guarded here and refused with a 4xx, never fed to `WHERE id = $1` where the
// uuid cast would throw a 500 (OBS-049, INV-102).
const approvalIdShape = z.uuid();

// The injectable seams, each optional with a production default resolved lazily below.
export interface ReleaseSeams {
  // Resolve the session from the request (server-verified; INV-101). Production reads
  // the host-locked cookie and verifies it over the shared database.
  readonly resolveSession?: (request: Request) => Promise<Session | null>;
  // The shared database (every query parameter-bound; INV-102).
  readonly db?: Db;
  // Judges step-up freshness and the 90-day fingerprint window.
  readonly clock?: Clock;
  // The process-wide in-memory store the value is put into (design §4.2).
  readonly releaseStore?: ReleaseStore;
  // Unwraps the person's DEK to fingerprint the released value.
  readonly keyWrapper?: KeyWrapper;
  // The origin every POST's Origin header must match (design §5). Production reads
  // the configured public base URL.
  readonly publicOrigin?: string;
}

// --- production defaults ------------------------------------------------------------

// Read one cookie's value out of the request's Cookie header, or null when absent.
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// The real session resolver: read the host-locked session cookie and verify it
// server-side over the process-wide database (never trusting any other client value —
// INV-101). The database is taken lazily, per request, so importing this module boots
// nothing.
async function defaultResolveSession(request: Request): Promise<Session | null> {
  const token = readCookie(request, COOKIE_NAME);
  if (token == null) return null;
  const db = await getServerDb();
  return verifySession(db, token, { clock: systemClock });
}

// The KeyWrapper from validated config (local AES-256 outside production; Key Vault in
// production). Read at request time, never at module load (`next build` has no runtime
// config), and only when no wrapper is injected — so tests reading no config never
// touch `process.env`.
function defaultKeyWrapper(): KeyWrapper {
  const config = loadConfig();
  return selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
}

// --- responses ----------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// A release that cannot go ahead, answered with its status and stable error code.
// Inside the release transaction a refusal is RETURNED (the transaction commits), not
// thrown: no refusal path has anything to undo — the budget check runs before any
// write, an expiry stored by the decision should stand, and a concurrent approval of
// the same request is genuine. Only an unexpected failure throws and rolls back.
interface ReleaseRefused {
  readonly status: number;
  readonly code: string;
}

// The stable error codes the browser maps to plain copy.
const NOT_RELEASABLE = "not_releasable";
const ALREADY_RELEASED = "already_released";
const EXPIRED = "expired";
const OVER_BUDGET = "over_budget";

// What a card release counts against the agent's budget: the approved amount in the
// budget's currency (the converted amount when the request was in another currency)
// and the merchant. Null when the stored detail does not carry a usable amount — the
// release is then refused rather than counted wrongly.
function cardSpendOf(
  detail: Record<string, unknown>,
): { amount: number; currency: string; merchant: string } | null {
  const converted = detail.converted as { amount?: unknown; currency?: unknown } | undefined;
  const amount = converted?.amount ?? detail.amount;
  const currency = converted?.currency ?? detail.currency;
  const merchant = detail.merchant;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  if (typeof currency !== "string" || typeof merchant !== "string") return null;
  return { amount, currency, merchant };
}

// Whether an approval can still be released by this request: a pending one (approved
// in the same step) or an approved one whose value has not been handed over yet.
function stillReleasable(approval: StoredApproval): boolean {
  if (approval.releasedAt !== undefined) return false;
  return approval.status === "pending" || approval.status === "approved";
}

// --- the handler --------------------------------------------------------------------

export function createReleaseHandler(
  seams: ReleaseSeams = {},
): { POST(request: Request, id: string): Promise<Response> } {
  const resolveSession = seams.resolveSession ?? defaultResolveSession;

  async function POST(request: Request, id: string): Promise<Response> {
    const clock = seams.clock ?? systemClock;
    const store = seams.releaseStore ?? releaseStore;

    try {
      // 1. Origin FIRST (design §5): a missing or foreign Origin changes nothing. The
      //    body must be JSON, so a cross-site "simple" text/plain post is refused too.
      const publicOrigin = seams.publicOrigin ?? new URL(loadConfig().publicBaseUrl).origin;
      if (request.headers.get("origin") !== publicOrigin) {
        return json(403, { error: "forbidden" });
      }
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return json(415, { error: "unsupported_media_type" });
      }

      // 2. Auth boundary (INV-101): a server-verified session, or nothing happens —
      //    identity is the session's user id, never a client value.
      const session = await resolveSession(request);
      if (session == null) {
        return json(401, { error: "unauthenticated" });
      }

      // A step-up within the last 5 minutes is required for a release (design §5);
      // a missing / stale step-up releases nothing.
      if (!requireStepUp(session, { clock })) {
        return json(403, { error: "step_up_required" });
      }

      // 3. Shape-guard the id BEFORE any query: a non-UUID is a 4xx, never a raw cast.
      if (!approvalIdShape.safeParse(id).success) {
        return json(400, { error: "invalid_id" });
      }

      const db = seams.db ?? (await getServerDb());
      const keyWrapper = seams.keyWrapper ?? defaultKeyWrapper();
      const userId = session.userId;

      // Resolve the person's unwrapped DEK (member-scoped by the session user): read
      // their wrapped DEK and unwrap it through the KeyWrapper seam. It keys both the
      // approval-detail decryption and the released-value fingerprint.
      const user = await getUserById(db, userId);
      if (user == null) {
        return json(403, { error: NOT_RELEASABLE });
      }
      const dek = await keyWrapper.unwrap(user.wrappedDek);

      // 4. Load the approval MEMBER-SCOPED by the session user: another user's id finds
      //    nothing. Only a card / high-tier RELEASE that is pending or approved and not
      //    yet released can be released — a uniform 4xx that leaks nothing otherwise.
      const approval = await getApproval(db, userId, id, dek);
      if (approval == null || !isReleaseRequest(approval.detail.request)) {
        return json(403, { error: NOT_RELEASABLE });
      }
      if (approval.releasedAt !== undefined) {
        return json(409, { error: ALREADY_RELEASED });
      }
      if (approval.status === "expired") {
        return json(403, { error: EXPIRED });
      }
      if (!stillReleasable(approval)) {
        return json(403, { error: NOT_RELEASABLE });
      }
      const kind = approval.detail.request;

      // 5. The requesting agent, re-resolved member-scoped: it must still be connected
      //    and still allowed this access, so a value is never planted for an agent the
      //    person has since disconnected or restricted.
      const agent = await getAgentById(db, userId, approval.agentId);
      if (agent == null || agent.status !== "connected") {
        return json(403, { error: NOT_RELEASABLE });
      }
      const permissions = await getConnectionPermissions(db, userId, agent.connectionId);
      const allowed = kind === "card" ? permissions?.cardAccess === true : permissions?.highTierAccess === true;
      if (!permissions || !allowed) {
        return json(403, { error: NOT_RELEASABLE });
      }
      const spend = kind === "card" ? cardSpendOf(approval.detail) : null;
      if (kind === "card" && (spend === null || permissions.cardBudget === null || spend.currency !== permissions.cardBudget.currency)) {
        // A card release must be counted against the agent's budget; one that cannot be
        // (no usable amount, no budget, or a currency the budget is not kept in) is refused.
        return json(403, { error: NOT_RELEASABLE });
      }

      // 6. Validate the body (`{ value }`): malformed / oversized / mis-shaped is a 4xx
      //    (never a 500), before any store or db write.
      const { value } = await parseBody(bodySchema, request, { maxBytes: MAX_BODY_BYTES });

      // 7. ONE transaction: approve (if pending), mark released exactly once, count a
      //    card's spend, and persist the keyed one-way fingerprint (the audit record).
      //    Any refusal rolls every write back. The value itself is never written to the
      //    database, a log or a metric — only its fingerprint, for 90 days.
      const now = clock.now();
      // Budget periods follow the person's own time zone (review fix W4.3): the budget
      // check below and the ledger row it writes use the same local day/week/month the
      // policy engine and the spending views read.
      const timeZone = spend !== null ? await timeZoneFor(db, userId, dek) : undefined;
      const refused = await withTransaction(db, async (tx): Promise<ReleaseRefused | null> => {
        // Serialise releases for this agent (its row locked for the transaction), so two
        // approvals made before either was released cannot together overspend a budget.
        await tx.query("SELECT id FROM agents WHERE id = $1 AND user_id = $2 FOR UPDATE", [agent.id, userId]);

        if (spend !== null && permissions.cardBudget !== null) {
          const budget = permissions.cardBudget;
          const spent = await sumForConnectionPeriod(
            tx,
            userId,
            agent.connectionId,
            budget.period,
            periodKeyFor(budget.period, now, timeZone),
          );
          if (spent + spend.amount > budget.amount) {
            return { status: 409, code: OVER_BUDGET };
          }
        }

        if (approval.status === "pending") {
          try {
            await decide(tx, { userId, id, decision: { status: "approved" } }, dek, clock);
          } catch (error) {
            if (!(error instanceof ApprovalAlreadyDecidedError)) throw error;
            // A concurrent approval of the same request stands; anything else does not
            // (an overdue approval has just been stored expired).
            if (error.status === "expired") return { status: 403, code: EXPIRED };
            if (error.status !== "approved") return { status: 403, code: NOT_RELEASABLE };
          }
        }

        if (!(await markReleased(tx, { userId, id }, clock))) {
          return { status: 409, code: ALREADY_RELEASED };
        }

        if (spend !== null) {
          const household = await getHouseholdForMember(tx, userId);
          await recordRelease(tx, {
            userId,
            connectionId: agent.connectionId,
            householdId: household?.id ?? null,
            amount: spend.amount,
            currency: spend.currency,
            merchant: spend.merchant,
            periodKeys: {
              day: periodKeyFor("day", now, timeZone),
              week: periodKeyFor("week", now, timeZone),
              month: periodKeyFor("month", now, timeZone),
            },
            approvalId: id,
          });
        }

        await storeFingerprint(tx, { userId, fingerprint: fingerprint(dek, value) }, clock);

        // Record the release in the activity feed, in the same transaction (brief: the
        // release is recorded without the value; a card's approved amount and merchant
        // are recorded). Warthog writes it, redacted and DEK-encrypted — the value is
        // never part of it.
        const recorder = createRedactingRecorder({ db: tx, clock, dekFor: async () => dek });
        await recorder.record({
          userId,
          kind: kind === "card" ? "card_release" : "identity_release",
          source: "warthog",
          agentId: agent.id,
          tool: typeof approval.detail.tool === "string" ? approval.detail.tool : undefined,
          outcome: "released",
          merchant: spend?.merchant,
          payload:
            spend !== null
              ? { approvalId: id, amount: spend.amount, currency: spend.currency }
              : { approvalId: id, field: approval.detail.field, purpose: approval.detail.purpose },
        });
        return null;
      });
      if (refused !== null) {
        return json(refused.status, { error: refused.code });
      }

      // 8. Hand the value to the agent's single collection through the in-memory store,
      //    under the requesting agent's REAL connection — the SAME key `collect_release`
      //    reads it with (never the agent's row id).
      store.put(
        releaseKeyFor({ userId, connectionId: agent.connectionId, agentId: agent.id, active: true }),
        value,
      );

      return json(200, { status: "released" });
    } catch (error) {
      // The input boundary throws exactly HttpError (always a 4xx), so a malformed /
      // oversized body maps to a client error, never an uncontrolled 500.
      if (error instanceof HttpError) {
        return json(error.status, { error: "invalid_request" });
      }
      throw error;
    }
  }

  return { POST };
}
