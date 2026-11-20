// The Requests loader (src/server/admin/page-data.ts `loadRequests`; docs/adr/admin-portal.md,
// amendment of 20 November 2026): what settles a request (the operator's mark, the catalogue
// having the service, the person being on the Google list), the filters and counts, the name
// cleaned and redacted for display, and the Overview naming waiting requests.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { loadOverview, loadRequests, loadUsage, type AdminPageDeps } from "./page-data";
import { NOW, seedAdminWorld } from "./seed.test-helper";

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function depsFor(db: Awaited<ReturnType<typeof freshDb>>, overrides: Partial<AdminPageDeps> = {}): AdminPageDeps {
  return {
    db, clock: fixedClock(NOW), timeZone: "Australia/Sydney", smsEnabled: false,
    connectorName: (id) => ({ "google-gmail": "Gmail", "google-drive": "Google Drive" } as Record<string, string>)[id],
    ...overrides,
  };
}

async function addRequest(db: Awaited<ReturnType<typeof freshDb>>, userId: string, name: string, at: string, extra: { kind?: string; connectorId?: string; handledAt?: string } = {}) {
  const result = await db.query(
    "INSERT INTO connector_requests (user_id, kind, service_name, connector_id, status, requested_at, handled_at) VALUES ($1, $2, $3, $4, 'requested', $5::timestamptz, $6::timestamptz) RETURNING id",
    [userId, extra.kind ?? "service", name, extra.connectorId ?? null, at, extra.handledAt ?? null],
  );
  return result.rows[0]!.id as string;
}

test("Requests: what settles a request, the filters and their counts", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    await addRequest(db, seeded.fresh, "Gmail", hoursAgo(1), { kind: "google_early_access", connectorId: "google-gmail" });
    await addRequest(db, seeded.factorOnly, "Google Drive", hoursAgo(1.5), { kind: "google_early_access", connectorId: "google-drive" });
    await addRequest(db, seeded.factorOnly, "Declined Thing", hoursAgo(3), { handledAt: hoursAgo(2) });
    const deps = depsFor(db, {
      catalogueMatch: (name) => (name.trim().toLowerCase() === "spotify" ? "Spotify" : undefined),
      onGoogleEarlyAccess: (email) => email === "factor@example.test",
    });

    const waiting = await loadRequests(deps);
    assert.equal(waiting.filter, "waiting", "the page opens on what's waiting");
    assert.deepEqual(waiting.counts, { waiting: 2, done: 4, all: 6 });
    assert.deepEqual(waiting.requests.map((r) => [r.serviceName, r.kind]), [["Gmail", "google_early_access"], ["Once Only Service", "service"]]);
    assert.equal(waiting.requests[0]!.person.email, "fresh@example.test");

    const done = await loadRequests(deps, { filter: "done" });
    const resolutions = Object.fromEntries(done.requests.map((r) => [r.serviceName.trim(), r.resolution]));
    assert.deepEqual(resolutions["Google Drive"], { by: "allowlist" }, "early access is done once they're on the Google list");
    assert.deepEqual(resolutions["Declined Thing"], { by: "operator", at: hoursAgo(2) });
    assert.deepEqual(resolutions["Spotify"], { by: "catalogue", serviceName: "Spotify" }, "a service request is done once the catalogue has it");
    assert.equal(done.requests.length, 4);

    const all = await loadRequests(deps, { filter: "all", notice: "done" });
    assert.equal(all.requests.length, 6);
    assert.equal(all.notice, "done");
    const odd = await loadRequests(deps, { filter: "drop table", notice: "<script>" });
    assert.equal(odd.filter, "waiting");
    assert.equal(odd.notice, null);
  } finally {
    await db.close();
  }
});

test("Requests: an automatic settle wins over the operator's mark; without the seams only the mark settles", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    await addRequest(db, seeded.fresh, "Spotify", hoursAgo(1), { handledAt: hoursAgo(0.5) });
    const model = await loadRequests(depsFor(db), { filter: "all" });
    const resolved = model.requests.filter((r) => r.resolution !== null);
    assert.deepEqual(resolved.map((r) => [r.person.email, r.resolution?.by]), [["fresh@example.test", "operator"]]);
    assert.equal(model.counts.waiting, 3);
    assert.equal(model.capped, false);

    const asked: string[] = [];
    const matched = await loadRequests(depsFor(db, {
      catalogueMatch: (name, email) => { asked.push(email); return name.trim().toLowerCase() === "spotify" ? "Spotify" : undefined; },
    }), { filter: "done" });
    const marked = matched.requests.find((r) => r.person.email === "fresh@example.test")!;
    assert.deepEqual(marked.resolution, { by: "catalogue", serviceName: "Spotify" }, "no 'Move back to waiting' on a request that settled itself");
    assert.ok(asked.includes("fresh@example.test"), "the match is asked for the person who asked");
  } finally {
    await db.close();
  }
});

test("Requests: the person's words are shown without card numbers or invisible characters, and capped", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    await addRequest(db, seeded.fresh, "Acme 4111 1111 1111 1111 Bank‮​", hoursAgo(1));
    await addRequest(db, seeded.fresh, "x".repeat(250), hoursAgo(2));
    await addRequest(db, seeded.fresh, "   ", hoursAgo(3));
    const model = await loadRequests(depsFor(db));
    const [card, long, blank] = model.requests;
    assert.ok(card!.serviceName.startsWith("Acme "), card!.serviceName);
    assert.ok(!card!.serviceName.includes("4111 1111 1111 1111") && !card!.serviceName.includes("4111111111111111"), "the card number is masked");
    assert.ok(!/[‮​]/.test(card!.serviceName), "invisible characters are removed");
    assert.equal(long!.serviceName.length, 120);
    assert.equal(blank!.serviceName, "(no name)");
  } finally {
    await db.close();
  }
});

test("Requests: the Overview says how many are waiting and links to them; Usage counts only service requests", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    await addRequest(db, seeded.fresh, "Gmail", hoursAgo(1), { kind: "google_early_access", connectorId: "google-gmail" });
    const overview = await loadOverview(depsFor(db), "7d");
    const item = overview.attention.find((a) => a.id === "requests");
    assert.deepEqual(item, { id: "requests", tone: "warning", href: "/requests", text: "4 requests are waiting for you." });
    assert.equal(overview.attention[0]!.id, "requests", "it comes first: it's something only the operator can do");
    assert.ok(!JSON.stringify(overview).includes("@example.test"), "the Overview names no one");

    const usage = await loadUsage(depsFor(db), "7d");
    const total = usage.servicesRequested.find((r) => r.key === "_total");
    assert.deepEqual(total, { key: "_total", label: "All requests for a service", value: 3, href: "/requests?filter=all" }, "early access isn't a request for a service");

    await db.query("UPDATE connector_requests SET handled_at = $1::timestamptz", [hoursAgo(0.1)]);
    const settled = await loadOverview(depsFor(db), "7d");
    assert.equal(settled.attention.find((a) => a.id === "requests"), undefined);
  } finally {
    await db.close();
  }
});

test("Requests: a Contact us message shows its topic and text, and only the operator settles it", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    await db.query(
      "INSERT INTO connector_requests (user_id, kind, service_name, topic, message, status, requested_at) VALUES ($1, 'contact', 'A privacy request', 'privacy', $2, 'requested', $3::timestamptz)",
      [seeded.fresh, "Please delete my imported history.​\n\nThanks!", hoursAgo(0.5)],
    );
    const deps = depsFor(db, {
      catalogueMatch: () => "Anything",
      onGoogleEarlyAccess: () => true,
    });
    const waiting = await loadRequests(deps);
    const message = waiting.requests.find((r) => r.kind === "contact")!;
    assert.equal(message.serviceName, "A privacy request");
    assert.equal(message.topic, "A privacy request");
    assert.equal(message.message, "Please delete my imported history.\n\nThanks!", "shown cleaned, line breaks kept");
    assert.equal(message.resolution, null, "neither the catalogue nor the Google list answers a message");
    assert.equal(message.person.email, "fresh@example.test");

    const overview = await loadOverview(deps, "7d");
    assert.match(overview.attention.find((a) => a.id === "requests")!.text, /waiting for you/);
  } finally {
    await db.close();
  }
});
