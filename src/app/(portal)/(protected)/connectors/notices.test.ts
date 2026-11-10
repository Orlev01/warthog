import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorNotice } from "./notices";

test("provider consent follow-up and declined connections are shown to the person", () => {
  const followUp = connectorNotice("provider-revoke-needed");
  assert.equal(followUp?.tone, "info");
  assert.match(followUp!.text, /remove.*consent|consent.*remove/i);
  const declined = connectorNotice("connection-declined");
  assert.equal(declined?.tone, "info");
  assert.match(declined!.text, /not connected/);
});

test("connector feedback distinguishes completed actions, prerequisites and failure", () => {
  assert.equal(connectorNotice("connected")?.tone, "success");
  assert.equal(connectorNotice("key-needed")?.tone, "info");
  assert.equal(connectorNotice("problem")?.tone, "error");
});

test("unrecognised query values never become notification content", () => {
  for (const value of [undefined, ["connected"], "", "toString", "__proto__", "<script>"]) {
    assert.equal(connectorNotice(value), null);
  }
});
