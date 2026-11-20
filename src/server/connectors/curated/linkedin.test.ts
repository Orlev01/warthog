// Curated LinkedIn tools (src/server/connectors/curated/linkedin.ts; docs/adr/linkedin-connector.md):
// the member's own profile, a post Warthog builds from plain fields, and deleting a post (the
// post's Undo). Each call goes only to LinkedIn's API host with the person's own token, and a
// connection that needs reconnecting, or isn't theirs, sends nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { LINKEDIN_CURATED_TOOLS, LINKEDIN_VERSION, callLinkedInTool, linkedInAccountLabel } from "./linkedin";
import { createUser } from "../../db/users";
import { createConnection, type ConnectionStatus } from "../../db/connections";
import { freshDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { HttpError } from "../../http/validate";
import type { CatalogueEntry } from "../../../domain/catalogue/schema";

const TOKEN = "linkedin-ACCESS-TOKEN-SECRET";
const ENTRY: CatalogueEntry = {
  id: "linkedin", name: "LinkedIn", aliases: ["linked in"], category: "social", auth_kind: "oauth2",
  base_url: "https://api.linkedin.com",
  auth: { authorize_url: "https://www.linkedin.com/oauth/v2/authorization", token_url: "https://www.linkedin.com/oauth/v2/accessToken", scopes: ["openid", "profile", "email", "w_member_social"] },
};

interface Seen { url: string; method: string; headers: Headers; body: string }

function linkedInFake(routes: Record<string, () => Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = String(init?.method ?? "GET");
    seen.push({ url, method, headers: new Headers(init?.headers as HeadersInit), body: typeof init?.body === "string" ? init.body : "" });
    const route = routes[`${method} ${url}`];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fn, seen };
}

const USERINFO = "GET https://api.linkedin.com/v2/userinfo";
const userinfo = () => Response.json({ sub: "782bbtaQ", name: "Sam Lee", given_name: "Sam", family_name: "Lee", email: "sam@example.com", email_verified: true, picture: "https://media.licdn.com/p.jpg", locale: { country: "AU", language: "en" } });

async function world(status: ConnectionStatus = "connected") {
  const db = await freshDb();
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `li-${randomBytes(4).toString("hex")}@warthog.test`, wrappedDek: "w" });
  const connection = await createConnection(db, {
    userId: user.id, connectorId: "linkedin", accountLabel: "sam@example.com", status,
    credentials: { access_token: TOKEN, token_type: "Bearer", expires_at: "2027-01-19T00:00:00.000Z" },
  }, dek, { now: () => new Date("2026-11-20T00:00:00.000Z") });
  const call = (tool: string, extra: Record<string, unknown> = {}) => ({ tool, entry: ENTRY, userId: user.id, connectionId: connection.id, dek, ...extra });
  return { db, user, connection, call };
}

async function closing<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } finally { await db.close(); }
}

test("three tools: the profile reads, a post and its deletion make changes, and a post is undone by deleting it", () => {
  assert.deepEqual(LINKEDIN_CURATED_TOOLS.map((t) => [t.name, t.makesChange, t.reversalTool ?? null]), [
    ["linkedin__profile", false, null],
    ["linkedin__create_post", true, "linkedin__delete_post"],
    ["linkedin__delete_post", true, null],
  ]);
  assert.ok(LINKEDIN_CURATED_TOOLS.every((t) => t.connectorId === "linkedin" && t.sendsMessage === false));
});

test("the profile is the member's own name, email and photo from LinkedIn's sign-in profile", async () => {
  const { db, call } = await world();
  await closing(db, async () => {
    const li = linkedInFake({ [USERINFO]: userinfo });
    const result = await callLinkedInTool(call("linkedin__profile"), { db, fetch: li.fetch });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { name: "Sam Lee", givenName: "Sam", familyName: "Lee", email: "sam@example.com", emailVerified: true, picture: "https://media.licdn.com/p.jpg" });
    assert.equal(li.seen.length, 1);
    assert.equal(li.seen[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
  });
});

test("a post is built by Warthog: the member's id from their profile, then one post with LinkedIn's version headers", async () => {
  const { db, call } = await world();
  await closing(db, async () => {
    const li = linkedInFake({
      [USERINFO]: userinfo,
      "POST https://api.linkedin.com/rest/posts": () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7262000000000000001" } }),
    });
    const result = await callLinkedInTool(call("linkedin__create_post", { post: { text: "Hiring (two roles) #design", visibility: "PUBLIC" } }), { db, fetch: li.fetch });
    assert.equal(result.status, 201);
    assert.deepEqual(JSON.parse(result.body), {
      id: "urn:li:share:7262000000000000001",
      url: "https://www.linkedin.com/feed/update/urn:li:share:7262000000000000001/",
      visibility: "PUBLIC",
    });
    assert.deepEqual(li.seen.map((r) => `${r.method} ${r.url}`), [USERINFO, "POST https://api.linkedin.com/rest/posts"]);
    const post = li.seen[1]!;
    assert.equal(post.headers.get("linkedin-version"), LINKEDIN_VERSION);
    assert.match(LINKEDIN_VERSION, /^20\d{4}$/);
    assert.equal(post.headers.get("x-restli-protocol-version"), "2.0.0");
    assert.equal(post.headers.get("content-type"), "application/json");
    assert.equal(post.headers.get("authorization"), `Bearer ${TOKEN}`);
    const body = JSON.parse(post.body) as Record<string, unknown>;
    assert.equal(body.author, "urn:li:person:782bbtaQ");
    assert.equal(body.commentary, "Hiring \\(two roles\\) #design");
    assert.equal(body.visibility, "PUBLIC");
  });
});

test("LinkedIn's refusal comes back as it is, and a post LinkedIn didn't give an id for is reported as done without one", async () => {
  const { db, call } = await world();
  await closing(db, async () => {
    const refused = linkedInFake({ [USERINFO]: userinfo, "POST https://api.linkedin.com/rest/posts": () => Response.json({ message: "Content is a duplicate" }, { status: 422 }) });
    const r = await callLinkedInTool(call("linkedin__create_post", { post: { text: "Again" } }), { db, fetch: refused.fetch });
    assert.equal(r.status, 422);
    assert.match(r.body, /duplicate/);

    const noId = linkedInFake({ [USERINFO]: userinfo, "POST https://api.linkedin.com/rest/posts": () => new Response(null, { status: 201 }) });
    const done = await callLinkedInTool(call("linkedin__create_post", { post: { text: "Hi" } }), { db, fetch: noId.fetch });
    assert.equal(done.status, 201);
    assert.deepEqual(JSON.parse(done.body), { posted: true, visibility: "CONNECTIONS" });

    const noProfile = linkedInFake({ [USERINFO]: () => new Response("expired", { status: 401 }) });
    const lapsed = await callLinkedInTool(call("linkedin__create_post", { post: { text: "Hi" } }), { db, fetch: noProfile.fetch });
    assert.equal(lapsed.status, 401, "a lapsed token stops before anything is posted");
    assert.equal(noProfile.seen.length, 1);
  });
});

test("a post Warthog can't build is refused before anything reaches LinkedIn", async () => {
  const { db, call } = await world();
  await closing(db, async () => {
    const li = linkedInFake({ [USERINFO]: userinfo });
    for (const post of [{ text: "" }, { text: "x".repeat(3001) }, { text: "x", link: { url: "http://example.com" } }, undefined]) {
      await assert.rejects(callLinkedInTool(call("linkedin__create_post", { post }), { db, fetch: li.fetch }), (e: unknown) => e instanceof HttpError && e.status === 400);
    }
    assert.equal(li.seen.length, 0);
  });
});

test("deleting a post sends one DELETE for that post id, and refuses anything that isn't a post id", async () => {
  const { db, call } = await world();
  await closing(db, async () => {
    const li = linkedInFake({ "DELETE https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A7262000000000000001": () => new Response(null, { status: 204 }) });
    const result = await callLinkedInTool(call("linkedin__delete_post", { query: { id: "urn:li:share:7262000000000000001" } }), { db, fetch: li.fetch });
    assert.equal(result.status, 204);
    assert.equal(li.seen[0]!.headers.get("x-restli-method"), "DELETE");
    assert.equal(li.seen[0]!.headers.get("linkedin-version"), LINKEDIN_VERSION);
    for (const id of ["urn:li:person:1", "../me", "urn:li:share:1/x", ""]) {
      await assert.rejects(callLinkedInTool(call("linkedin__delete_post", { query: { id } }), { db, fetch: li.fetch }), HttpError, id);
    }
    assert.equal(li.seen.length, 1);
  });
});

test("a connection that needs reconnecting, someone else's, or an unknown tool sends nothing", async () => {
  const { db, call } = await world("needs_reconnect");
  await closing(db, async () => {
    const li = linkedInFake({ [USERINFO]: userinfo });
    await assert.rejects(callLinkedInTool(call("linkedin__profile"), { db, fetch: li.fetch }), (e: unknown) => e instanceof HttpError && e.status === 409);
    const other = await createUser(db, { email: "other@warthog.test", wrappedDek: "w" });
    await assert.rejects(callLinkedInTool({ ...call("linkedin__profile"), userId: other.id }, { db, fetch: li.fetch }), (e: unknown) => e instanceof HttpError && e.status === 404);
    await assert.rejects(callLinkedInTool(call("linkedin__send_message"), { db, fetch: li.fetch }), (e: unknown) => e instanceof HttpError && e.status === 400);
    assert.equal(li.seen.length, 0);
  });
});

test("a LinkedIn account is named by its email, or by the member's name when LinkedIn gives no email", () => {
  assert.equal(linkedInAccountLabel({ email: "sam@example.com", name: "Sam Lee" }), "sam@example.com");
  assert.equal(linkedInAccountLabel({ name: "  Sam​ Lee " }), "Sam Lee");
  assert.equal(linkedInAccountLabel({ email: "not-an-address", name: "Sam" }), "Sam");
  assert.equal(linkedInAccountLabel({}), "LinkedIn account");
  assert.equal(linkedInAccountLabel({ name: "x".repeat(500) }).length <= 120, true);
});
