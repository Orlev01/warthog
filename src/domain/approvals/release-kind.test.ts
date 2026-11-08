// Review fix C2 — one discriminator for "this approval is a RELEASE" (a card or a
// high-tier identity detail the agent collects with collect_release), shared by the
// pipeline, check_approval and the inbox, so they can never disagree about which
// approvals are run as tools and which are collected.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isReleaseRequest } from "./release-kind";

test("card and high_tier requests are releases", () => {
  assert.equal(isReleaseRequest("card"), true);
  assert.equal(isReleaseRequest("high_tier"), true);
});

test("anything else is a routine held call, not a release", () => {
  for (const value of [undefined, null, "", "CARD", "high-tier", 1, {}, ["card"]]) {
    assert.equal(isReleaseRequest(value), false, `${JSON.stringify(value)} is not a release`);
  }
});
