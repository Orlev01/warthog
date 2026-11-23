// The approval card's summary of what a held call would send (src/domain/approvals/outgoing.ts;
// docs/adr/approval-card-truth.md), for the kinds this file covers: a LinkedIn post.
import { test } from "node:test";
import assert from "node:assert/strict";

import { outgoingDetail } from "./outgoing";

test("a LinkedIn post's card shows the text that will be posted, who sees it and where its link goes", () => {
  const detail = outgoingDetail({
    tool: "linkedin__create_post",
    connector: "linkedin",
    params: { text: "Big news​ today", visibility: "PUBLIC", link: { url: "https://www.example.com/news" }, reason: "asked" },
  });
  assert.deepEqual(detail, {
    kind: "post", excerpt: "Big news today", text: "Big news today", visibility: "PUBLIC",
    link: "https://www.example.com/news", linkDomain: "example.com", linkTitle: "example.com",
  });
  const titled = outgoingDetail({
    tool: "linkedin__create_post",
    connector: "linkedin",
    params: { text: "Big news", link: { url: "https://example.com/n", title: "Official: CEO resigns", description: "Read the statement." } },
  });
  assert.equal(titled?.kind === "post" ? titled.linkTitle : undefined, "Official: CEO resigns", "the published title is on the card");
  assert.equal(titled?.kind === "post" ? titled.linkDescription : undefined, "Read the statement.");
  assert.equal(outgoingDetail({ tool: "linkedin__create_post", connector: "linkedin", params: { text: "Hi" } })?.kind, "post");
  assert.equal(outgoingDetail({ tool: "linkedin__create_post", connector: "linkedin", params: {} }), undefined, "no text, nothing to show");
});

test("deleting a LinkedIn post names the post on the card", () => {
  assert.deepEqual(
    outgoingDetail({ tool: "linkedin__delete_post", connector: "linkedin", params: { query: { id: "urn:li:share:7262000000000000001" } } }),
    { kind: "post_delete", url: "https://www.linkedin.com/feed/update/urn:li:share:7262000000000000001/" },
  );
  assert.equal(outgoingDetail({ tool: "linkedin__delete_post", connector: "linkedin", params: { query: { id: "javascript:alert(1)" } } }), undefined);
  assert.equal(outgoingDetail({ tool: "linkedin__delete_post", connector: "linkedin", params: {} }), undefined);
});

// UI/UX audit 2026-11-23 W-01: a held call to one of Warthog's own tools (a rule such as "Ask
// me before Claude makes any change") must say WHAT it would add or change, or the person
// approves blind — three different tasks used to read as three identical cards.
test("Warthog's own tools show what they would add or change", () => {
  assert.deepEqual(
    outgoingDetail({ tool: "create_task", connector: null, params: { title: "Book the car service", assignee: "any", reason: "x" } }),
    { kind: "core", title: "Book the car service", lines: [{ key: "For", preview: "Any agent" }] },
  );
  assert.deepEqual(
    outgoingDetail({ tool: "remember", connector: null, params: { content: "Prefers aisle seats​ on long flights" } }),
    { kind: "core", lines: [{ key: "Memory", preview: "Prefers aisle seats on long flights" }] },
  );
  assert.deepEqual(
    outgoingDetail({
      tool: "save_record",
      connector: null,
      params: { type: "vehicles.registration", fields: { name: "Car registration", provider: "Service NSW", plate: "ABC12D", amount: "912", currency: "AUD" } },
    }),
    { kind: "core", title: "Car registration", lines: [{ key: "Provider", preview: "Service NSW" }, { key: "Plate", preview: "ABC12D" }, { key: "Amount", preview: "912" }] },
  );
  assert.deepEqual(
    outgoingDetail({
      tool: "save_record",
      connector: null,
      params: { records: [{ fields: { name: "Netflix" } }, { fields: { name: "Spotify" } }, { fields: { name: "Gym" } }, { fields: { name: "Paramount+" } }] },
    }),
    { kind: "core", count: 4, lines: [{ key: "Records", preview: "Netflix, Spotify, Gym and 1 more" }] },
  );
  assert.deepEqual(
    outgoingDetail({ tool: "update_record", connector: null, params: { id: "a4d7eeec-0000-4000-8000-000000000000", fields: { amount: "950" }, status: "done", dueDate: "2026-12-20" } }),
    { kind: "core", lines: [{ key: "Amount", preview: "950" }, { key: "Status", preview: "done" }, { key: "Due", preview: "2026-12-20" }] },
  );
  assert.deepEqual(
    outgoingDetail({ tool: "update_task", connector: null, params: { id: "x", status: "done", note: "Paid online" } }),
    { kind: "core", lines: [{ key: "Status", preview: "done" }, { key: "Note", preview: "Paid online" }] },
  );
  assert.deepEqual(
    outgoingDetail({ tool: "log_activity", connector: null, params: { reason: "Booked the car hire", amount: 412.5, currency: "NZD" } }),
    { kind: "core", lines: [{ key: "Note", preview: "Booked the car hire" }, { key: "Amount", preview: "412.5 NZD" }] },
  );
  assert.equal(outgoingDetail({ tool: "complete_task", connector: null, params: { id: "x" } }), undefined, "nothing beyond the id to show");
  assert.notEqual(
    outgoingDetail({ tool: "create_task", connector: "some-service", params: { title: "x" } })?.kind,
    "core",
    "a service's tool that happens to share a name is not one of Warthog's own",
  );
  const long = outgoingDetail({ tool: "create_task", connector: null, params: { title: "x".repeat(500) } });
  assert.ok(long?.kind === "core" && (long.title?.length ?? 0) <= 200, "titles are cut to a card-sized length");
});
