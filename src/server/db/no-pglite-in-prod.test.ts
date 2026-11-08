// Review fix F1 — the production server must load the database module without PGlite.
//
// PGlite is a devDependency, and next.config excludes it from the standalone output's file
// tracing, so in the container image `@electric-sql/pglite` does not exist. The database seam
// must therefore resolve PGlite only when a `pglite:` URL is actually opened: a process that
// runs against `postgres://` must import src/server/db/index.ts, create its pool and fail only
// at the first query, with a network error — never with ERR_MODULE_NOT_FOUND at module load.
//
// The test reproduces the standalone image's module graph in a child process: a resolve hook
// makes `@electric-sql/pglite` unresolvable (exactly as it is in the image), then the child
// imports the real module and drives a postgres:// database at a dead port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// The project root (this file is at src/server/db/no-pglite-in-prod.test.ts).
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// A module-resolution hook that behaves like the standalone image: PGlite is not installed.
const BLOCK_PGLITE_HOOK = `
export async function resolve(specifier, context, next) {
  if (specifier === "@electric-sql/pglite" || specifier.startsWith("@electric-sql/pglite/")) {
    const error = new Error("Cannot find package '@electric-sql/pglite' (blocked by test)");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return next(specifier, context);
}`;

const REGISTER_BLOCKER =
  `import { register } from "node:module";` +
  `register(${JSON.stringify("data:text/javascript," + encodeURIComponent(BLOCK_PGLITE_HOOK))});`;

// Runs `script` (an ES module body) in a child node with tsx and the blocker, from the root.
async function runWithoutPglite(script: string): Promise<{ code: number | null; out: string }> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "data:text/javascript," + encodeURIComponent(REGISTER_BLOCKER),
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, out };
}

test("the blocker really hides PGlite (control: a pglite: URL cannot be opened)", async () => {
  const { code, out } = await runWithoutPglite(`
    const { createDb } = await import("./src/server/db/index.ts");
    try {
      await createDb("pglite:memory");
      console.log("OPENED");
    } catch (error) {
      console.log("REFUSED", error.code);
    }
  `);
  assert.equal(code, 0, out);
  assert.match(out, /REFUSED ERR_MODULE_NOT_FOUND/);
});

test("without PGlite installed, the db module loads and a postgres: URL reaches the network", async () => {
  const { code, out } = await runWithoutPglite(`
    const { createDb } = await import("./src/server/db/index.ts");
    const db = await createDb("postgres://u:p@127.0.0.1:1/none");
    try {
      await db.query("SELECT 1");
      console.log("QUERIED");
    } catch (error) {
      console.log("QUERY FAILED", error.code);
    } finally {
      await db.close().catch(() => {});
    }
  `);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|electric-sql/);
  assert.match(out, /QUERY FAILED ECONNREFUSED/);
});
