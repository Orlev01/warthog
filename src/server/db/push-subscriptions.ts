// The push-subscription aggregate's data access (design §10 Notifications, brief
// "Notification settings" / "Approval notifications"). Approval notifications push
// to EVERY registered device within seconds, so a person may register ONE OR MORE
// devices for Web Push; each device's subscription carries a push-service
// `endpoint` and the two Web Push keys (`p256dh` + `auth`).
//
// The endpoint and keys are PER-PERSON DEVICE DATA — personal content — so they are
// stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1): the id is generated
// up front so each envelope's associated data can bind the ciphertext to its exact
// (table, column, row) — the plaintext never lands in a column.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and the
// member-scope user id travel as BOUND values, never concatenated into the SQL text,
// so a value shaped like SQL is stored as data and cannot alter the query. Every read
// and write is member-scoped by the `user_id` the caller passes — the session's id,
// never a client value — so one person can never read or remove another's
// subscription. Time enters through the injected Clock (never SQL now()); the DEK is
// injected (this module reads no `process.env` and holds no key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";

// The envelope's associated data binds each ciphertext to its exact location, so a
// row lifted into another row/column/table fails to decrypt.
const TABLE = "push_subscriptions";
const ENDPOINT_COLUMN = "endpoint";
const KEYS_COLUMN = "keys";

// The columns every read returns, kept in one place so the listing hands back a
// uniform shape. `endpoint` and `keys` come back as ciphertext here and are
// decrypted separately before they reach a caller.
const COLUMNS = "id, user_id, endpoint, keys, created_at, expires_at";

// The two Web Push keys (base64url), DEK-encrypted at rest.
export interface PushKeys {
  readonly p256dh: string;
  readonly auth: string;
}

// What registerSubscription needs: the person (the session's id, never a client
// value), the device's push-service endpoint, the Web Push keys, and an optional
// expirationTime (omitted / null ⇒ the subscription never expires).
export interface NewPushSubscription {
  readonly userId: string;
  readonly endpoint: string;
  readonly keys: PushKeys;
  readonly expiresAt?: Date | string | null;
}

// A subscription as handed back to callers: the generated id, the DECRYPTED endpoint
// and keys, the register instant and the stored expirationTime (null when it never
// expires).
export interface StoredPushSubscription {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly keys: PushKeys;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

// What removeSubscription needs: the person (member scope) and the subscription id.
export interface RemoveSubscriptionInput {
  readonly userId: string;
  readonly id: string;
}

// A stored instant comes back as a Date or an ISO/epoch representation depending on
// the driver; normalise to a Date.
function toDate(value: unknown): Date {
  return new Date(value as string | number | Date);
}

// Normalise an optional expirationTime input to a Date or null (omitted / null ⇒
// never expires).
function toExpiry(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

// Map a raw row (plus its already-decrypted endpoint + keys) to a
// StoredPushSubscription, translating the snake_case columns to camelCase fields.
function toStored(row: Row, endpoint: string, keys: PushKeys): StoredPushSubscription {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    endpoint,
    keys,
    createdAt: toDate(row.created_at),
    expiresAt: row.expires_at != null ? toDate(row.expires_at) : null,
  };
}

// Register an ACTIVE subscription for `userId` with its endpoint + keys DEK-encrypted
// (createdAt = clock.now()). The id is generated up front so each envelope can bind to
// it. Returns the StoredPushSubscription carrying the generated id (assembled from the
// inputs, like createHeldRequest — it does not depend on a RETURNING read). A person
// may register several (one per device).
export async function registerSubscription(
  db: Db,
  input: NewPushSubscription,
  dek: Uint8Array,
  clock: Clock,
): Promise<StoredPushSubscription> {
  const id = randomUUID();
  const createdAt = clock.now();
  const expiresAt = toExpiry(input.expiresAt);
  const endpointEnvelope = await encrypt(dek, TABLE, ENDPOINT_COLUMN, id, input.endpoint);
  const keysEnvelope = await encrypt(dek, TABLE, KEYS_COLUMN, id, JSON.stringify(input.keys));

  await db.query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, keys, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
    [
      id,
      input.userId,
      endpointEnvelope,
      keysEnvelope,
      createdAt.toISOString(),
      expiresAt ? expiresAt.toISOString() : null,
    ],
  );

  return {
    id,
    userId: input.userId,
    endpoint: input.endpoint,
    keys: input.keys,
    createdAt,
    expiresAt,
  };
}

// ALL of `userId`'s ACTIVE subscriptions (member-scoped: user_id bound), endpoint +
// keys decrypted under `dek`; never another person's. An active subscription is one
// that is NOT removed (removal deletes the row) and NOT expired (expires_at is null or
// strictly after clock.now()). Empty array when the person has none active.
export async function listSubscriptions(
  db: Db,
  userId: string,
  dek: Uint8Array,
  clock: Clock,
): Promise<StoredPushSubscription[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM push_subscriptions
      WHERE user_id = $1
        AND (expires_at IS NULL OR expires_at > $2::timestamptz)
      ORDER BY created_at`,
    [userId, clock.now().toISOString()],
  );
  const subscriptions: StoredPushSubscription[] = [];
  for (const row of result.rows) {
    const id = row.id as string;
    const endpoint = await decrypt(dek, TABLE, ENDPOINT_COLUMN, id, row.endpoint as string);
    const keysJson = await decrypt(dek, TABLE, KEYS_COLUMN, id, row.keys as string);
    subscriptions.push(toStored(row, endpoint, JSON.parse(keysJson) as PushKeys));
  }
  return subscriptions;
}

// Remove the one subscription OWNED BY `userId` with this id (member-scoped: id AND
// user_id both bound), so it is no longer returned by listSubscriptions. Returns true
// when a subscription was removed, false when none matched for this user (idempotent —
// removing something that is not there, or another user's id, is not an error and
// changes nothing). The DEK is not needed to remove, so it is accepted but unused.
export async function removeSubscription(
  db: Db,
  { userId, id }: RemoveSubscriptionInput,
  dek?: Uint8Array,
): Promise<boolean> {
  void dek;
  const result = await db.query(
    `DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return result.rows.length > 0;
}
