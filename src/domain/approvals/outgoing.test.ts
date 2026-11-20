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
    link: "https://www.example.com/news", linkDomain: "example.com",
  });
  assert.equal(outgoingDetail({ tool: "linkedin__create_post", connector: "linkedin", params: { text: "Hi" } })?.kind, "post");
  assert.equal(outgoingDetail({ tool: "linkedin__create_post", connector: "linkedin", params: {} }), undefined, "no text, nothing to show");
  assert.equal(outgoingDetail({ tool: "linkedin__delete_post", connector: "linkedin", params: { query: { id: "urn:li:share:1" } } }), undefined);
});
