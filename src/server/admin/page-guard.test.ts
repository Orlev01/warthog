// Every admin page checks the admin session itself (src/server/admin/page-guard.ts), before
// it reads anything and outside its try/catch. The portal layout's check alone can be skipped
// by a crafted client navigation, which renders a page without its layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ADMIN_PREFIX } from "../http/admin-routing";

const PORTAL = join(process.cwd(), "src", "app", ADMIN_PREFIX.replace(/^\//, ""), "(portal)");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

test("every admin page verifies the admin session before it loads, outside its try/catch", () => {
  const found = pages(PORTAL);
  assert.ok(found.length >= 8, `found ${found.length} admin pages`);
  for (const path of found) {
    const source = readFileSync(path, "utf8");
    const guard = source.indexOf("await requireAdminPage();");
    assert.ok(guard > 0, `${path} calls requireAdminPage`);
    const body = source.slice(source.indexOf("export default async function"));
    assert.ok(body.indexOf("await requireAdminPage();") < body.indexOf("try {"), `${path} checks before its try/catch`);
    for (const load of ["getAdminPageDeps(", "load"]) {
      const at = body.indexOf(load, body.indexOf("{"));
      assert.ok(at === -1 || at > body.indexOf("await requireAdminPage();"), `${path} reads nothing before the check (${load})`);
    }
  }
});
