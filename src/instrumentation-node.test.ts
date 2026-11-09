import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("production startup terminates even when the framework catches its rejected instrumentation hook", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerNode } from "./src/instrumentation-node.ts";
    // Next's standalone server catches the rejected hook and otherwise stays alive.
    try { await registerNode(); } catch { console.log("framework-caught-startup-error"); }
    process.exit(0);
  `], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { NODE_ENV: "production" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /\[warthog\] production startup failed; terminating/);
  assert.doesNotMatch(result.stderr, /Missing required configuration/);
  assert.doesNotMatch(result.stdout, /framework-caught-startup-error/);
});

test("development startup still rejects invalid configuration for local diagnostics", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerNode } from "./src/instrumentation-node.ts";
    try { await registerNode(); process.exit(2); }
    catch (error) { console.log(error.message); }
  `], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { NODE_ENV: "development" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing required configuration: PUBLIC_BASE_URL/);
});
