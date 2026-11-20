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
