// "Your requests" on Connectors (`./actions` load + <ConnectorsView/>; brief "Request a
// connector": "the person sees their requests with a 'Requested' status";
// docs/adr/requests-for-members.md). The loader hands back the session person's own service
// and early-access requests, newest first, each with what's become of it: still requested,
// ready to connect (the service is now in the catalogue for them, or they're on the Google
// list) or reviewed by the operator. A gated Google entry the person has already asked to join
// says so instead of offering the ask again. "Contact us" messages live on the Contact page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createConnectorsActions } from "./actions";
import { ConnectorsView } from "@/components/connectors/connectors-view";
import { createConnectorRequest } from "@/server/db/connector-requests";
import { createUser } from "@/server/db/users";
import { loadCatalogue, type CatalogueIndex } from "@/server/connectors/catalogue";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const apiKey = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  aliases: [],
  category: "email",
  auth_kind: "api_key",
  base_url: `https://api.${id}.example`,
  auth: { header: "Authorization: Bearer {api_key}" },
  ...extra,
});
const ENTRIES = [apiKey("acme-mail", "Acme Mail", { aliases: ["acme"] }), apiKey("gee-mail", "Gee Mail", { google_early_access: true })];

function catalogue(): CatalogueIndex {
  const dir = mkdtempSync(join(tmpdir(), "warthog-connectors-requests-"));
  try {
    for (const entry of ENTRIES) writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry));
    return loadCatalogue({ dir, isOAuthClientConfigured: () => false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const deks = new Map<string, Uint8Array>();
function actionsFor(db: Db, googleEarlyAccess: string[] = []) {
  return createConnectorsActions({
    db,
    clock: fixedClock(NOW),
    catalogue: catalogue(),
    dekFor: async (userId) => deks.get(userId)!,
    fetch: (async () => {
      throw new Error("no fetch in these tests");
    }) as unknown as typeof fetch,
    googleEarlyAccess,
    oauthClientConfigFor: () => ({ clientId: "c", clientSecret: "s", redirectUri: "https://warthog.com.au/cb" }),
    providerMcpConfig: { clientMetadataUrl: "https://warthog.com.au/oauth/client-metadata.json" },
    listProviderTools: async () => [],
    revokeProviderAccess: async () => {},
  });
}

async function makeUser(db: Db, who: string): Promise<{ id: string; email: string }> {
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: "w" });
  deks.set(user.id, randomBytes(32));
  return { id: user.id, email: user.email };
}
const session = (userId: string): Session => ({ id: `s-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null });
const at = (daysAgo: number) => fixedClock(new Date(NOW.getTime() - daysAgo * DAY));
const noop = async (): Promise<void> => {};

test("the person sees their own requests, newest first, each with what's become of it", async () => {
  const db = await freshDb();
  try {
    const me = await makeUser(db, "me");
    const other = await makeUser(db, "other");
    await createConnectorRequest(db, { userId: me.id, serviceName: "Fax machine" }, at(5));
    await createConnectorRequest(db, { userId: me.id, serviceName: "acme" }, at(4));
    const reviewed = await createConnectorRequest(db, { userId: me.id, serviceName: "Carrier pigeon" }, at(3));
    await db.query("UPDATE connector_requests SET handled_at = $2::timestamptz WHERE id = $1", [reviewed.id, NOW.toISOString()]);
    await createConnectorRequest(db, { userId: me.id, serviceName: "Gee Mail", kind: "google_early_access", connectorId: "gee-mail" }, at(2));
    await createConnectorRequest(db, { userId: me.id, kind: "contact", serviceName: "A question", topic: "question", message: "Hi" }, at(1));
    await createConnectorRequest(db, { userId: other.id, serviceName: "Someone else's" }, at(1));

    const data = await actionsFor(db).load(session(me.id));
    assert.deepEqual(
      data.requests?.map((r) => [r.name, r.kind, r.status]),
      [
        ["Gee Mail", "early_access", "waiting"],
        ["Carrier pigeon", "service", "reviewed"],
        ["Acme Mail", "service", "ready"],
        ["Fax machine", "service", "waiting"],
      ],
    );
    const ready = data.requests!.find((r) => r.status === "ready")!;
    assert.equal(ready.findHref, "/connectors?view=catalogue&q=Acme+Mail");
    assert.ok(data.requests!.every((r) => typeof r.askedAt === "string" && r.askedAt.length > 0));

    const allowed = await actionsFor(db, [me.email]).load(session(me.id));
    assert.equal(allowed.requests!.find((r) => r.kind === "early_access")!.status, "ready", "on the list, so they're in");
  } finally {
    await db.close();
  }
});

test("Connectors lists the requests in their own panel, and an entry already asked for says so instead of offering the ask", async () => {
  const db = await freshDb();
  try {
    const me = await makeUser(db, "asker");
    await createConnectorRequest(db, { userId: me.id, serviceName: "Gee Mail", kind: "google_early_access", connectorId: "gee-mail" }, at(1));
    await createConnectorRequest(db, { userId: me.id, serviceName: "acme" }, at(2));
    const data = await actionsFor(db).load(session(me.id));
    const gee = data.groups.flatMap((g) => g.items).find((item) => item.id === "gee-mail")!;
    assert.equal(gee.gate, "ask_to_join");
    assert.equal(gee.asked, true);

    const markup = renderToStaticMarkup(<ConnectorsView {...data} initialView="catalogue" connectAction={noop} requestAction={noop} />);
    assert.match(markup, /Your requests/);
    assert.match(markup, /Asked to join/);
    assert.match(markup, /We&#x27;ll email you when you&#x27;re in/);
    assert.ok(!/<form[^>]*>(?:(?!<\/form>).)*name="connectorId" value="gee-mail"/s.test(markup), "no second ask-to-join form");
    assert.match(markup, /Ready to connect/);
    assert.match(markup, /href="\/connectors\?view=catalogue&amp;q=Acme\+Mail"/);
    assert.match(markup, /Requested/);
  } finally {
    await db.close();
  }
});

test("with no requests there's no requests panel", async () => {
  const db = await freshDb();
  try {
    const me = await makeUser(db, "quiet");
    const data = await actionsFor(db).load(session(me.id));
    assert.deepEqual(data.requests, []);
    const markup = renderToStaticMarkup(<ConnectorsView {...data} initialView="catalogue" connectAction={noop} requestAction={noop} />);
    assert.ok(!markup.includes("Your requests"));
  } finally {
    await db.close();
  }
});
