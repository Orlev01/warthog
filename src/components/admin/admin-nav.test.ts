import { test } from "node:test";
import assert from "node:assert/strict";

import { ADMIN_ICONS, ADMIN_NAV_GROUPS, activeAdminSection, adminMeasureFor } from "./admin-nav";

test("every admin destination is grouped once, un-prefixed, with an icon", () => {
  const items = ADMIN_NAV_GROUPS.flatMap((g) => g.items);
  assert.deepEqual(items.map((i) => i.href), ["/", "/signups", "/usage", "/accounts", "/reliability", "/traffic", "/system"]);
  assert.equal(new Set(items.map((i) => i.key)).size, items.length);
  for (const item of items) {
    assert.ok(!item.href!.startsWith("/admin"), `${item.href} is served un-prefixed on the admin host`);
    assert.ok(ADMIN_ICONS[item.key], `${item.key} has an icon`);
  }
  assert.deepEqual(ADMIN_NAV_GROUPS.map((g) => g.label), ["Overview", "Product", "Health"]);
});

test("the active section follows the original path and never throws", () => {
  assert.equal(activeAdminSection("/"), "overview");
  assert.equal(activeAdminSection("/usage"), "usage");
  assert.equal(activeAdminSection("/usage/"), "usage");
  assert.equal(activeAdminSection("/accounts?filter=no_factor"), "accounts");
  assert.equal(activeAdminSection("/system/anything"), "system");
  assert.equal(activeAdminSection("/usages"), null, "a lookalike is not owned");
  assert.equal(activeAdminSection(""), null);
  assert.equal(activeAdminSection(undefined as unknown as string), null);
});

test("dashboards are wide; Accounts and System read at the narrower measure", () => {
  for (const key of ["overview", "signups", "usage", "reliability", "traffic"]) assert.equal(adminMeasureFor(key), "wide", key);
  assert.equal(adminMeasureFor("accounts"), "reading");
  assert.equal(adminMeasureFor("system"), "reading");
  assert.equal(adminMeasureFor(null), "reading");
});
