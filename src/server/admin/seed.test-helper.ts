// A seeded database for the admin portal's tests: a few live accounts at different stages
// of activation, a tombstone, sessions, agents, connections (one needing reconnection),
// approvals, activity, metric events of every kind the portal reads, jobs, sweep runs and a
// household — plus deliberately recognisable CONTENT strings (an address, an identity value,
// an activity payload, connection credentials and label) that no admin read may ever return.
import type { Db } from "../db/index";

export const SECRET_EMAIL = "secret-person@example.test";
export const SECRET_IDENTITY = "IDENTITY-VALUE-NEVER-SHOWN";
export const SECRET_PAYLOAD = "PAYLOAD-CIPHERTEXT-NEVER-SHOWN";
export const SECRET_CREDENTIALS = "CREDENTIALS-NEVER-SHOWN";
export const SECRET_LABEL = "label-never-shown@example.test";
export const SECRET_AGENT_NAME = "Agent Name Never Shown";

// "Now" for the seeded world: 13 Nov 2026 09:30 Sydney (22:30 UTC on the 12th).
export const NOW = new Date("2026-11-12T22:30:00Z");

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

async function user(db: Db, email: string, createdAt: string, options: { role?: string; dek?: string } = {}): Promise<string> {
  const result = await db.query(
    "INSERT INTO users (email, wrapped_dek, role, created_at) VALUES ($1, $2, $3, $4::timestamptz) RETURNING id",
    [email, options.dek ?? "wrapped", options.role ?? "member", createdAt],
  );
  return result.rows[0]!.id as string;
}

export interface Seeded {
  readonly complete: string; // every milestone reached
  readonly factorOnly: string;
  readonly fresh: string; // signed up today, nothing else
  readonly reconnect: string; // has a failing connection
  readonly tombstone: string;
}

export async function seedAdminWorld(db: Db): Promise<Seeded> {
  const complete = await user(db, SECRET_EMAIL, daysAgo(20), { role: "admin" });
  const factorOnly = await user(db, "factor@example.test", daysAgo(5));
  const fresh = await user(db, "fresh@example.test", hoursAgo(2));
  const reconnect = await user(db, "reconnect@example.test", daysAgo(3));
  const tombstone = await user(db, "gone@example.test", daysAgo(40), { dek: "" });

  // Factors: complete has a passkey (a day after sign-up); factorOnly an authenticator.
  await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter, created_at) VALUES ($1, 'cred-complete', 'pk', 0, $2::timestamptz)", [complete, daysAgo(19)]);
  await db.query("INSERT INTO totp_secrets (user_id, secret_enc, created_at) VALUES ($1, 'enc', $2::timestamptz)", [factorOnly, daysAgo(5)]);
  await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter, created_at) VALUES ($1, 'cred-reconnect', 'pk', 0, $2::timestamptz)", [reconnect, daysAgo(3)]);

  // Identity content that must never surface.
  await db.query("INSERT INTO identity_fields (user_id, kind, value) VALUES ($1, 'name', $2)", [complete, SECRET_IDENTITY]);

  // Sessions: complete seen an hour ago, factorOnly 10 days ago, reconnect 2 days ago.
  for (const [id, seen, hash] of [[complete, hoursAgo(1), "h1"], [factorOnly, daysAgo(10), "h2"], [reconnect, daysAgo(2), "h3"]] as const) {
    await db.query("INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at) VALUES ($1, $2, $3::timestamptz, $3::timestamptz)", [id, hash, seen]);
  }

  // Agents: complete has an active Claude agent with requests; reconnect has a ChatGPT agent, idle.
  await db.query(
    "INSERT INTO agents (user_id, connection_id, display_name, platform, status, connected_at, last_active_at, request_count) VALUES ($1, gen_random_uuid(), $2, 'claude', 'connected', $3::timestamptz, $4::timestamptz, 12)",
    [complete, SECRET_AGENT_NAME, daysAgo(18), hoursAgo(3)],
  );
  await db.query(
    "INSERT INTO agents (user_id, connection_id, display_name, platform, status, connected_at, last_active_at, request_count) VALUES ($1, gen_random_uuid(), 'Other', 'chatgpt', 'connected', $2::timestamptz, $3::timestamptz, 0)",
    [reconnect, daysAgo(3), daysAgo(3)],
  );

  // Connections: complete has Gmail (healthy); reconnect has Gmail needing reconnection and Outlook healthy.
  await db.query("INSERT INTO connections (user_id, connector_id, account_label, status, credentials, connected_at) VALUES ($1, 'gmail', $2, 'connected', $3, $4::timestamptz)", [complete, SECRET_LABEL, SECRET_CREDENTIALS, daysAgo(17)]);
  await db.query("INSERT INTO connections (user_id, connector_id, account_label, status, credentials, connected_at) VALUES ($1, 'gmail', 'x', 'needs_reconnect', 'c', $2::timestamptz)", [reconnect, daysAgo(3)]);
  await db.query("INSERT INTO connections (user_id, connector_id, account_label, status, credentials, connected_at) VALUES ($1, 'outlook', 'y', 'connected', 'c', $2::timestamptz)", [reconnect, daysAgo(3)]);

  // Approvals for complete: two approved (decided quickly), one expired, one pending.
  const agentId = (await db.query("SELECT id FROM agents WHERE user_id = $1", [complete])).rows[0]!.id as string;
  await db.query("INSERT INTO approvals (user_id, agent_id, status, detail, created_at, expires_at, decided_at) VALUES ($1, $2, 'approved', 'd', $3::timestamptz, $4::timestamptz, $5::timestamptz)", [complete, agentId, daysAgo(16), daysAgo(15.9), daysAgo(15.99)]);
  await db.query("INSERT INTO approvals (user_id, agent_id, status, detail, created_at, expires_at, decided_at) VALUES ($1, $2, 'approved', 'd', $3::timestamptz, $4::timestamptz, $5::timestamptz)", [complete, agentId, daysAgo(2), daysAgo(1.9), daysAgo(1.99)]);
  await db.query("INSERT INTO approvals (user_id, agent_id, status, detail, created_at, expires_at) VALUES ($1, $2, 'expired', 'd', $3::timestamptz, $4::timestamptz)", [complete, agentId, daysAgo(1), daysAgo(0.98)]);
  await db.query("INSERT INTO approvals (user_id, agent_id, status, detail, created_at, expires_at) VALUES ($1, $2, 'pending', 'd', $3::timestamptz, $4::timestamptz)", [complete, agentId, hoursAgo(0.1), hoursAgo(-0.2)]);

  // Activity: complete's first tool call 17 days ago, with content ciphertext that must never surface.
  await db.query(
    "INSERT INTO activity_entries (user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool, outcome, payload_ct, prev_hash, entry_hash) VALUES ($1, 1, $2::timestamptz, 'tool_call', 'warthog', 'a', 'gmail', 'gmail.search', 'executed', $3, 'p', 'e')",
    [complete, daysAgo(17), SECRET_PAYLOAD],
  );

  // Metric events across the last days.
  const metric = (name: string, value: number, at: string, dims: { platform?: string; connectorId?: string; outcome?: string; errorCategory?: string } = {}) =>
    db.query(
      "INSERT INTO metric_events (name, value, recorded_at, platform, connector_id, outcome, error_category) VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)",
      [name, value, at, dims.platform ?? null, dims.connectorId ?? null, dims.outcome ?? null, dims.errorCategory ?? null],
    );
  for (let d = 0; d < 10; d++) {
    await metric("agent.request", 1, hoursAgo(d * 24 + 1), { platform: "claude", connectorId: "gmail", outcome: "executed" });
    await metric("agent.request.latency_ms", 100 + d * 10, hoursAgo(d * 24 + 1), { platform: "claude", connectorId: "gmail", outcome: "executed" });
  }
  await metric("agent.request", 1, hoursAgo(5), { platform: "claude", connectorId: "gmail", outcome: "failed", errorCategory: "tool_error" });
  await metric("agent.request.latency_ms", 900, hoursAgo(5), { platform: "claude", connectorId: "gmail", outcome: "failed", errorCategory: "tool_error" });
  await metric("agent.request", 1, hoursAgo(6), { platform: "chatgpt", outcome: "refused", errorCategory: "denied" });
  await metric("agent.request.latency_ms", 20, hoursAgo(6), { platform: "chatgpt", outcome: "refused", errorCategory: "denied" });
  await metric("approval.decision", 1, daysAgo(1.99), { outcome: "approved" });
  await metric("approval.response_time_ms", 240_000, daysAgo(1.99), { outcome: "approved" });
  await metric("signup.step", 1, hoursAgo(2.5), { outcome: "code_sent" });
  await metric("signup.step", 1, hoursAgo(2.4), { outcome: "email_verified" });
  await metric("signup.step", 1, hoursAgo(2.2), { outcome: "factor_enrolled", platform: "passkey" });
  await metric("signup.completed", 1, hoursAgo(2), { outcome: "ok", platform: "passkey" });
  await metric("signup.step", 1, daysAgo(4), { outcome: "code_sent" });
  await metric("signup.step", 1, daysAgo(4), { outcome: "throttled" });
  await metric("signin.attempt", 1, hoursAgo(1), { outcome: "ok", platform: "passkey" });
  await metric("signin.attempt", 1, hoursAgo(4), { outcome: "failed", errorCategory: "passkey" });
  await metric("signin.attempt", 1, daysAgo(2), { outcome: "failed", errorCategory: "totp" });
  await metric("connector.refresh", 1, daysAgo(2), { connectorId: "gmail", outcome: "failed" });
  await metric("connector.connect", 1, daysAgo(3), { connectorId: "outlook", outcome: "ok" });
  await metric("job.failure", 1, hoursAgo(7), { outcome: "connection.refresh" });
  await metric("integrity.check", 3, hoursAgo(8), { outcome: "pass" });
  await metric("integrity.check", 0, hoursAgo(8), { outcome: "fail" });
  await metric("users.total", 4, hoursAgo(1));
  await metric("http.requests", 5, hoursAgo(1), { outcome: "app.portal.document" });
  await metric("http.requests", 20, hoursAgo(1), { outcome: "app.portal.fetch" });
  await metric("http.requests", 2, hoursAgo(1), { outcome: "admin.admin.document" });
  await metric("http.requests", 1, hoursAgo(1), { outcome: "app.auth.limited" });
  await metric("http.requests", 3, daysAgo(2), { outcome: "app.public.document" });

  // Jobs, sweeps, a household, an admin session, a connector request, lockout alerts.
  await db.query("INSERT INTO jobs (type, payload, run_at, status, attempts) VALUES ('connection.refresh', '{}', $1::timestamptz, 'failed', 3)", [hoursAgo(7)]);
  await db.query("INSERT INTO jobs (type, payload, run_at, status, attempts) VALUES ('approval.fallback', '{}', $1::timestamptz, 'pending', 0)", [hoursAgo(0.5)]);
  for (const [name, at] of [["approval-expiry", hoursAgo(0.01)], ["traffic-flush", hoursAgo(0.02)], ["exchange-rates", daysAgo(5)], ["metrics-snapshot", hoursAgo(1)]] as const) {
    await db.query("INSERT INTO sweep_runs (name, last_run_at) VALUES ($1, $2::timestamptz)", [name, at]);
  }
  const householdId = (await db.query("INSERT INTO households (owner_id, currency) VALUES ($1, 'AUD') RETURNING id", [complete])).rows[0]!.id as string;
  await db.query("INSERT INTO household_members (household_id, user_id, role) VALUES ($1, $2, 'owner')", [householdId, complete]);
  await db.query("INSERT INTO household_members (household_id, user_id, role) VALUES ($1, $2, 'member')", [householdId, factorOnly]);
  const sessionId = (await db.query("SELECT id FROM sessions WHERE user_id = $1", [complete])).rows[0]!.id as string;
  await db.query("INSERT INTO admin_sessions (session_id, user_id, handoff_expires_at, token_hash, created_at, exchanged_at, last_seen_at) VALUES ($1, $2, $3::timestamptz, 'tok', $3::timestamptz, $3::timestamptz, $3::timestamptz)", [sessionId, complete, hoursAgo(1)]);
  await db.query("INSERT INTO connector_requests (user_id, service_name, status, requested_at) VALUES ($1, 'Spotify', 'requested', $2::timestamptz)", [complete, daysAgo(1)]);
  await db.query("INSERT INTO connector_requests (user_id, service_name, status, requested_at) VALUES ($1, ' spotify ', 'requested', $2::timestamptz)", [reconnect, daysAgo(2)]);
  await db.query("INSERT INTO connector_requests (user_id, service_name, status, requested_at) VALUES ($1, 'Once Only Service', 'requested', $2::timestamptz)", [reconnect, daysAgo(2)]);
  await db.query("INSERT INTO passkey_alerts (user_id, sent_at) VALUES ($1, $2::timestamptz)", [reconnect, hoursAgo(3)]);

  return { complete, factorOnly, fresh, reconnect, tombstone };
}
