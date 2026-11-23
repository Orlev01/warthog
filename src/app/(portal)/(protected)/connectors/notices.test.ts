import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorNotice, connectorsReturnUrl } from "./notices";

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

test("every problem says what failed, and blank or missing input says what to type", () => {
  for (const key of ["connect-problem", "disconnect-problem", "request-problem", "request-name-missing", "verification-failed"]) {
    const notice = connectorNotice(key);
    assert.equal(notice?.tone, "error", key);
    assert.doesNotMatch(notice!.text, /something went wrong|credential/i, key);
  }
  assert.equal(connectorNotice("early-access-requested")?.tone, "success");
});

test("an action returns to the tab, search and category it came from, with its notice", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };
  assert.equal(
    connectorsReturnUrl(form({ return_view: "catalogue", return_q: "mail", return_category: "email" }), "connect-problem"),
    "/connectors?category=email&notice=connect-problem&q=mail&view=catalogue",
  );
  assert.equal(connectorsReturnUrl(form({ return_view: "connected" }), "disconnected"), "/connectors?notice=disconnected&view=connected");
  // Unknown tabs are dropped, the search and category only ride with the catalogue tab, and
  // the path is always /connectors whatever the form claims.
  assert.equal(connectorsReturnUrl(form({ return_view: "https://evil.example", return_q: "x" }), "problem"), "/connectors?notice=problem");
  assert.equal(connectorsReturnUrl(form({ return_view: "connected", return_q: "x", return_category: "y" }), "problem"), "/connectors?notice=problem&view=connected");
  assert.equal(connectorsReturnUrl(form({}), "requested"), "/connectors?notice=requested");
  assert.ok(connectorsReturnUrl(form({ return_view: "catalogue", return_q: "z".repeat(5000) }), "requested").length < 300, "bounded");
});

test("turning an account on or off for new agents says what changes and what doesn't", () => {
  for (const key of ["default-on", "default-off"]) {
    const notice = connectorNotice(key);
    assert.equal(notice?.tone, "success", key);
    assert.match(notice!.text, /Agents already connected don't change/, key);
  }
  assert.equal(connectorNotice("default-problem")?.tone, "error");
});
