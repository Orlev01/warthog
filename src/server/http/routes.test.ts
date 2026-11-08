// Review fix F13 — one provider OAuth callback, advertised the same everywhere.
//
// A provider sends the person back to Warthog's callback after they sign in. The callback path
// was spelled three ways — the CIMD document said /connectors/callback, the connectors page's
// authorize request said /connectors/callback, and Dynamic Client Registration said
// /oauth/callback — while the only route that exists is /connect/callback, so every provider
// sign-in would fail on its last step (or be refused as an unregistered redirect). One shared
// constant now names it, and these tests prove every advertised URI is that route.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { CONNECT_CALLBACK_PATH, connectCallbackUrl } from "./routes";
import { createClientMetadataHandler } from "@/app/oauth/client-metadata.json/handler";
import { connectProviderMcp } from "@/server/connectors/provider-mcp";
import type { CatalogueEntry } from "@/domain/catalogue/schema";
import type { Config } from "@/server/config";
import { createUser } from "@/server/db/users";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BASE = "https://warthog.com.au";

test("the callback path is a real App Router route", () => {
  assert.equal(CONNECT_CALLBACK_PATH, "/connect/callback");
  assert.ok(
    existsSync(join(ROOT, "src", "app", ...CONNECT_CALLBACK_PATH.split("/").filter(Boolean), "route.ts")),
    `src/app${CONNECT_CALLBACK_PATH}/route.ts exists`,
  );
});

test("connectCallbackUrl joins the configured base, with or without a trailing slash", () => {
  assert.equal(connectCallbackUrl(BASE), `${BASE}/connect/callback`);
  assert.equal(connectCallbackUrl(`${BASE}/`), `${BASE}/connect/callback`);
});

test("Warthog's CIMD document advertises the real callback", async () => {
  const handler = createClientMetadataHandler({ config: { publicBaseUrl: BASE } as Config });
  const document = (await handler(new Request(`${BASE}/oauth/client-metadata.json`)).json()) as {
    redirect_uris: string[];
  };
  assert.deepEqual(document.redirect_uris, [connectCallbackUrl(BASE)]);
});

test("Dynamic Client Registration with a provider registers the real callback", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "dcr@warthog.com.au", wrappedDek: "d3JhcHBlZA==" });
    const entry: CatalogueEntry = {
      id: "notion",
      name: "Notion",
      aliases: [],
      category: "productivity",
      auth_kind: "provider_mcp",
      base_url: "https://mcp.notion.com/mcp",
      auth: {},
    };
    let registered: { redirect_uris?: string[] } | undefined;
    const origin = "https://mcp.notion.com";
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(init?.method ?? "GET").toUpperCase() === "POST") {
        registered = JSON.parse(String(init?.body)) as { redirect_uris?: string[] };
        return Response.json({ client_id: "issued" }, { status: 201 });
      }
      return Response.json({
        issuer: origin,
        authorization_servers: [origin],
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        client_id_metadata_document_supported: false,
      });
    }) as typeof fetch;

    await connectProviderMcp(
      {
        entry,
        config: { clientMetadataUrl: `${BASE}/oauth/client-metadata.json` },
        userId: user.id,
        accountLabel: "Notion",
        dek: randomBytes(32),
      },
      { db, clock: fixedClock(new Date("2026-11-08T00:00:00Z")), fetch: fetchFn, listTools: async () => [] },
    );
    assert.deepEqual(registered?.redirect_uris, [connectCallbackUrl(BASE)]);
  } finally {
    await db.close();
  }
});
