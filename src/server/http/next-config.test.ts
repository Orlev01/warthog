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

// --- Review fix F9: the security headers restrict scripts and network access -----------------
//
// The CSP used to restrict only framing, plugins, <base> and form targets, so an injected script
// could load code from anywhere and send vault data to any host. It now defaults every fetch
// directive to the app's own origin. Next's App Router bootstraps with inline scripts, so
// script-src keeps 'unsafe-inline' (a nonce-based policy is the follow-up), but no external
// script source, no eval in production, and no off-site connect/img/font/frame target is
// allowed. HSTS covers subdomains.

// The headers next.config sends on every path, evaluated under `nodeEnv` (the policy differs in
// development, where Next's dev server needs eval and its HMR websocket).
async function securityHeaders(nodeEnv: string): Promise<Map<string, string>> {
  const saved = process.env.NODE_ENV;
  try {
    (process.env as Record<string, string>).NODE_ENV = nodeEnv;
    const url = `${pathToFileURL(join(ROOT, "next.config.mjs")).href}?env=${nodeEnv}`;
    const mod = (await import(url)) as {
      default: { headers(): Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    };
    const rules = await mod.default.headers();
    const all = rules.find((rule) => rule.source === "/:path*");
    assert.ok(all, "a header rule applies to every path");
    return new Map(all.headers.map((h) => [h.key.toLowerCase(), h.value]));
  } finally {
    if (saved === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = saved;
  }
}

function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

test("the production CSP confines every fetch directive to the app's own origin", async () => {
  const csp = directives((await securityHeaders("production")).get("content-security-policy") ?? "");
  assert.deepEqual(csp.get("default-src"), ["'self'"]);
  assert.deepEqual(csp.get("connect-src"), ["'self'"], "no off-site fetch/XHR/websocket");
  assert.deepEqual(csp.get("object-src"), ["'none'"]);
  assert.deepEqual(csp.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(csp.get("base-uri"), ["'self'"]);
  assert.deepEqual(csp.get("form-action"), ["'self'"]);

  const script = csp.get("script-src") ?? [];
  assert.ok(script.includes("'self'"));
  assert.ok(!script.includes("'unsafe-eval'"), "no eval in production");
  for (const directive of ["script-src", "style-src", "img-src", "font-src", "connect-src", "worker-src", "frame-src"]) {
    for (const source of csp.get(directive) ?? []) {
      assert.ok(
        source.startsWith("'") || source === "data:" || source === "blob:",
        `${directive} allows only keywords and local schemes, not ${source}`,
      );
    }
  }
});

test("the development CSP adds only what Next's dev server needs (eval and its HMR websocket)", async () => {
  const csp = directives((await securityHeaders("development")).get("content-security-policy") ?? "");
  assert.ok((csp.get("script-src") ?? []).includes("'unsafe-eval'"));
  assert.deepEqual(csp.get("default-src"), ["'self'"]);
});

test("HSTS lasts at least a year and covers subdomains", async () => {
  const hsts = (await securityHeaders("production")).get("strict-transport-security") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
  assert.ok(maxAge >= 31536000, `max-age ${maxAge} is at least a year`);
  assert.match(hsts, /;\s*includeSubDomains/);
});
