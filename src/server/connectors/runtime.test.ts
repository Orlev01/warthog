import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectorRuntime } from "./runtime";
import { loadConfig } from "../config";
import { createDb, loadMigrations, runMigrations } from "../db/index";
import { createUser } from "../db/users";
import { getConnectionCredentials } from "../db/connections";

const config = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://app.example.test", WEBAUTHN_RP_ID: "example.test",
  DATABASE_URL: "pglite:memory", WARTHOG_HMAC_KEY: Buffer.alloc(32, 11).toString("base64"), WARTHOG_DEV_KEK: Buffer.alloc(32, 12).toString("base64"),
  GOOGLE_CLIENT_ID: "test-google", GOOGLE_CLIENT_SECRET: "test-google-secret", MICROSOFT_CLIENT_ID: "test-microsoft", MICROSOFT_CLIENT_SECRET: "test-microsoft-secret", GOOGLE_EARLY_ACCESS: "owner@example.test" });
const now = new Date("2026-11-09T01:00:00Z");

test("Microsoft completes and refreshes an owned connection using the returned account and rotated refresh token", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const user = await createUser(db, { email: "owner@example.test", wrappedDek: "test-key" });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: "test-key" });
    const dek = new Uint8Array(32).fill(8);
    const session = { id: "microsoft-session", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };
    let tokenRequests = 0;
    const runtime = createConnectorRuntime({ db, config, clock: { now: () => now },
      keyWrapper: { wrap: async () => "unused", unwrap: async () => dek.slice() }, fetch: async (url, init) => {
        if (String(url).startsWith("https://graph.microsoft.com/v1.0/me?")) {
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer first-access");
          return Response.json({ mail: null, userPrincipalName: "connected@outlook.test" });
        }
        assert.equal(String(url), "https://login.microsoftonline.com/common/oauth2/v2.0/token");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("client_id"), "test-microsoft");
        tokenRequests++;
        const refreshing = body.get("grant_type") === "refresh_token";
        if (refreshing) assert.equal(body.get("refresh_token"), "initial-refresh");
        else { assert.ok(body.get("code_verifier")); assert.equal(body.get("redirect_uri"), "https://app.example.test/connect/callback"); }
        return Response.json({ access_token: refreshing ? "next-access" : "first-access", token_type: "Bearer", expires_in: 3600,
          refresh_token: refreshing ? "rotated-refresh" : "initial-refresh" });
      } });
    const url = new URL((await runtime.begin(session, "microsoft-outlook-calendar")).url);
    assert.ok(url.searchParams.get("scope")?.includes("Calendars.ReadWrite"));
    assert.ok(url.searchParams.get("scope")?.includes("User.Read"));
    assert.ok(!url.searchParams.get("scope")?.includes("Mail.ReadWrite"));
    const state = url.searchParams.get("state")!;
    const flow = runtime.take(session, state)!;
    const connected = await runtime.complete({ ...flow, userId: user.id, code: "code", state });
    assert.equal(connected.accountLabel, "connected@outlook.test");
    await runtime.refresh({ userId: other.id, connectionId: connected.id });
    assert.equal(tokenRequests, 1, "another person cannot refresh this connection");
    await runtime.refresh({ userId: user.id, connectionId: connected.id });
    const stored = await getConnectionCredentials(db, user.id, connected.id, dek);
    assert.equal(stored?.refresh_token, "rotated-refresh");
    const jobs = await db.query("SELECT type FROM jobs");
    assert.ok(jobs.rows.some((r) => r.type === "connection.refresh"));
    assert.ok(!jobs.rows.some((r) => String(r.type).includes("google")));
  } finally { await db.close(); }
});

test("Google connector completes PKCE, stores encrypted tokens, schedules refresh/lapse and refreshes without losing its refresh token", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const user = await createUser(db, { email: "owner@example.test", wrappedDek: "test-wrapped-key" });
    const session = { id: "initiating-session", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };
    const dek = new Uint8Array(32).fill(8);
    const requests: { url: string; body: string }[] = [];
    const runtime = createConnectorRuntime({ db, config, clock: { now: () => now }, keyWrapper: { wrap: async () => "unused", unwrap: async () => dek.slice() },
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body ?? "") });
        if (String(url).includes("userinfo")) return Response.json({ email: "connected@gmail.test" });
        if (String(url).includes("/revoke")) return new Response(null, { status: 200 });
        const refresh = String(init?.body).includes("grant_type=refresh_token");
        return Response.json({ access_token: refresh ? "new-access-token" : "first-access-token", token_type: "Bearer", expires_in: 3600,
          ...(refresh ? {} : { refresh_token: "refresh-token" }) });
      } });
    const drive = new URL((await runtime.begin(session, "google-drive")).url);
    assert.deepEqual(new Set(drive.searchParams.get("scope")?.split(" ")), new Set([
      "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/userinfo.email",
    ]), "Drive's curated tools only read files, so connection must not ask for write access");
    const start = await runtime.begin(session, "google-gmail");
    assert.deepEqual(Object.keys(start), ["url"], "the browser receives no verifier or client secret");
    const url = new URL(start.url);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.test/connect/callback");
    const state = url.searchParams.get("state")!;
    assert.equal(runtime.take({ ...session, id: "wrong-session" }, state), null);
    const flow = runtime.take(session, state)!;
    assert.ok(flow);
    const connection = await runtime.complete({ ...flow, userId: user.id, state, code: "authorization-code" });
    assert.equal(connection.accountLabel, "connected@gmail.test");
    assert.equal(runtime.take(session, state), null);
    const raw = await db.query("SELECT credentials FROM connections WHERE id = $1", [connection.id]);
    assert.ok(!JSON.stringify(raw).includes("first-access-token"));
    const jobs = await db.query("SELECT type FROM jobs");
    assert.ok(jobs.rows.some((r) => r.type === "connection.refresh"));
    assert.ok(jobs.rows.some((r) => r.type === "connection.google_lapse"));
    await runtime.refresh({ userId: user.id, connectionId: connection.id });
    const credentials = await getConnectionCredentials(db, user.id, connection.id, dek);
    assert.equal(credentials?.access_token, "new-access-token");
    assert.equal(credentials?.refresh_token, "refresh-token");
    await runtime.revoke({ userId: user.id, connectionId: connection.id, connectorId: "google-gmail", credentials: credentials! });
    assert.ok(requests.some((r) => r.url === "https://oauth2.googleapis.com/revoke"));
  } finally { await db.close(); }
});

test("Google admission is enforced on start and callback; Microsoft works for the common account endpoint", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const user = await createUser(db, { email: "not-allowlisted@example.test", wrappedDek: "test-key" });
    const session = { id: "s", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };
    const runtime = createConnectorRuntime({ db, config, clock: { now: () => now } });
    await assert.rejects(runtime.begin(session, "google-gmail"), /early access/i);
    await assert.rejects(runtime.complete({ userId: user.id, state: "state", connectorId: "google-gmail", codeVerifier: "verifier", accountLabel: "Gmail", code: "code" }), /early access/i);
    const microsoft = new URL((await runtime.begin(session, "microsoft-outlook-mail")).url);
    assert.equal(microsoft.origin, "https://login.microsoftonline.com");
    assert.ok(microsoft.pathname.includes("/common/"));
    assert.ok(microsoft.searchParams.get("scope")?.includes("offline_access"));
    await assert.rejects(runtime.revoke({ userId: user.id, connectionId: "id", connectorId: "microsoft-outlook-mail", credentials: {} }), /provider account/i);
  } finally { await db.close(); }
});
