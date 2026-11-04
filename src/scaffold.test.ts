// Operator scaffolding check: the toolchain the build loop depends on is wired as designed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("scripts the build loop and deploy rely on exist", () => {
  for (const s of ["dev", "build", "start", "test", "typecheck"]) assert.ok(pkg.scripts[s], `missing script ${s}`);
});

test("zod is v4 (the MCP SDK v2 requires ^4.2)", () => {
  assert.match(pkg.dependencies.zod, /^4\./);
});

test("no MPL web-push and no SMS SDK (see technical-design §3)", () => {
  assert.equal(pkg.dependencies["web-push"], undefined);
  assert.equal(pkg.dependencies["@azure/communication-sms"], undefined);
});
