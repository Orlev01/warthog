-- 0025_push_subscriptions — the push-subscription store (design §10 Notifications,
-- brief "Notification settings" / "Approval notifications").
--
-- Approval notifications push to EVERY registered device within seconds. A person
-- may register ONE OR MORE devices for Web Push; each device's subscription carries
-- a push-service `endpoint` and the two Web Push keys (`p256dh` + `auth`). The
-- endpoint and keys are PER-PERSON DEVICE DATA — personal content — so they are
-- stored only DEK-ENCRYPTED (design §4.1): `endpoint` and `keys` each hold a `v1:`
-- envelope (AES-256-GCM under the person's data key), never the plaintext.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client). Time is
-- clock-driven in application code (not SQL now()), so `created_at` is set at
-- register time. `expires_at` is the subscription's expirationTime: NULL means it
-- never expires; a value in the past makes the subscription inactive (not listed).

CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL,
  keys       text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);

-- listSubscriptions reads a person's active subscriptions (WHERE user_id = $1), so
-- index the member-scope column that every read filters on.
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
