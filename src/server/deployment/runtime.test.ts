import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntime } from "../../../scripts/prepare-runtime.mjs";

test("staging a standalone release requires and ships migrations, catalogue, public and static assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "warthog-package-"));
  try {
    const files = {
      ".next/standalone/server.js": "// server", ".next/standalone/package.json": "{}",
      ".next/static/chunks/app.js": "// app", "public/sw.js": "// worker",
      "db/migrations/0001.sql": "SELECT 1;", "catalogue/connectors/test.json": '{"id":"test"}',
      "package-lock.json": "{}", ".next/BUILD_ID": "test-build",
      ".env.local": "DO_NOT_SHIP_PRIVATE_TEST_VALUE",
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    const manifest = await prepareRuntime(root);
    assert.equal(manifest.migrations.length, 1);
    assert.equal(manifest.catalogue.length, 1);
    assert.equal(await readFile(join(root, ".runtime/public/sw.js"), "utf8"), "// worker");
    assert.equal(await readFile(join(root, ".runtime/.next/static/chunks/app.js"), "utf8"), "// app");
    await assert.rejects(readFile(join(root, ".runtime/.env.local")), /ENOENT/);
    await rm(join(root, "db/migrations"), { recursive: true });
    await assert.rejects(prepareRuntime(root), /migration/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a secret accidentally traced into standalone output is refused before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "warthog-package-secret-"));
  try {
    await mkdir(join(root, ".next/standalone"), { recursive: true });
    await writeFile(join(root, ".next/standalone/.env.production"), "private-test-value");
    await assert.rejects(prepareRuntime(root), /unsafe.*standalone/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
