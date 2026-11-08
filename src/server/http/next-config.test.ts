// Review fix F6 (and F9) — the framework configuration the whole app runs under
// (`next.config.mjs` at the app root).
//
// Next applies a 1 MB default body limit to every Server Action, BEFORE the action's own code
// runs. Receipts (life-admin, up to 25 MiB) and data imports (settings/data, up to 16 MiB) are
// uploaded through Server Actions, so with the default a typical phone photo or any real export
// fails with Next's unstyled 413 and the app's own limits never apply. The configured limit must
// leave room for the largest app-level upload plus its multipart framing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";

import { MAX_FILE_BYTES as MAX_RECEIPT_BYTES } from "@/app/(portal)/(protected)/life-admin/actions";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
// The same parser Next's action handler uses for `serverActions.bodySizeLimit`.
const bytes = require("next/dist/compiled/bytes") as { parse(value: string | number): number | null };

const IMPORT_MAX_BYTES = 16 * 1024 * 1024; // settings/data DEFAULT_MAX_UPLOAD_BYTES
const MULTIPART_HEADROOM = 64 * 1024; // boundaries, part headers and the other form fields

async function loadNextConfig(): Promise<Record<string, unknown>> {
  const mod = (await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)) as {
    default: Record<string, unknown>;
  };
  return mod.default;
}

test("the Server Action body limit admits the largest app-level upload with its framing", async () => {
  const config = await loadNextConfig();
  const experimental = config.experimental as { serverActions?: { bodySizeLimit?: string | number } } | undefined;
  const limit = experimental?.serverActions?.bodySizeLimit;
  assert.ok(limit !== undefined, "serverActions.bodySizeLimit must be set (Next's default is 1 MB)");
  const limitBytes = bytes.parse(limit);
  assert.ok(limitBytes !== null, `the limit ${String(limit)} must parse`);
  const largest = Math.max(MAX_RECEIPT_BYTES, IMPORT_MAX_BYTES);
  assert.ok(
    limitBytes >= largest + MULTIPART_HEADROOM,
    `the limit (${limitBytes} bytes) must admit a ${largest}-byte upload plus framing`,
  );
  // Still a cap: never unbounded, and not far beyond what the app accepts.
  assert.ok(limitBytes <= 2 * largest, "the limit stays close to the largest intended upload");
});
