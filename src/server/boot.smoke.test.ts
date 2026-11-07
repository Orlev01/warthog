// E18-S12 — Production build and boot check of the WHOLE composed app.
//
// RED-first: this is the FIRST task that actually runs the framework's production build
// (`next build`, standalone) and boots the started server (`npm start`) and drives it over
// HTTP. Until the whole app type-checks, bundles, boots and serves its own entry files,
// these tests fail — that absence IS the point of test-first (OBS-019: a plan of green
// modules that were never booted under the framework is NOT done). Do NOT weaken a test to
// make a failure disappear; the builder makes the composed app bootable instead.
//
// What these tests pin is BEHAVIOUR of the real artifact, never source text:
//   • `npm run build` exits 0 and emits the Next STANDALONE output (AC1).
//   • no secret value the build environment carried reaches the CLIENT bundle (AC4,
//     [obligation:secrets-from-env]).
//   • the started server binds the port given in `PORT` (a non-default port answers), serves
//     GET / with 200 and no session, and redirects an unauthenticated GET of a
//     (portal)/(protected) page to /signin (AC2 + AC5, [obligation:listen-on-port-env]).
//   • the agent connector (`POST /mcp`) and the OAuth authorization server respond over
//     HTTP, with the OAuth issuer taken from the PUBLIC_BASE_URL env (not a baked literal) —
//     proving config is read from env in the running app (AC3 + AC4).
//   • the primary journey is drivable end-to-end over HTTP: sign-up step one lands a code in
//     the process-wide dev outbox, visible on /dev/outbox — which only works if the route
//     handler and the page share ONE outbox singleton across the production module graphs
//     (AC3; the OBS-044 "verify singletons under next build + next start" gate).
//   • on boot the in-process job scheduler is started from instrumentation, announcing
//     itself on the app's own `[warthog jobs]` log channel (AC3).
//
// ── Environment note (why the boot runs in development mode against PGlite) ──────────────
// The Deploy node runs this artifact against managed Postgres; the test loop has only PGlite
// (conventions: "Database tests use PGlite"), and `src/server/config.ts` REFUSES a `pglite:`
// database and dev tools in production (a security invariant — correctly non-negotiable).
// The Next STANDALONE server hard-codes NODE_ENV=production, so it cannot drive the
// DB-backed, dev-tool journey without a real Postgres. `next start` (what `npm start` runs,
// and what AC2 names) honours a pre-set NODE_ENV, so we boot it in development against
// `pglite:memory` with dev tools on — the same code path, a different data source (the
// repo's `memory:`/dev-seam discipline). The build itself (AC1) and the client-bundle secret
// scan (AC4) are environment-independent and exercise the true production build.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The project root (this file is at src/server/boot.smoke.test.ts).
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Generous ceilings: a cold `next build` plus a `next start` boot is minutes of work, so the
// setup hook gets a wide timeout; the individual assertions are fast.
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 2 * 60 * 1000;
const SCHEDULER_TIMEOUT_MS = 60 * 1000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── helpers ─────────────────────────────────────────────────────────────────────────────

// A free TCP port on the loopback interface: bind :0, read the assigned port, release it.
// Deliberately non-3000 in practice (the OS hands out an ephemeral high port), so a server
// that answers on it proves it bound the PORT env var and not a 3000 literal.
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

interface RunResult {
  readonly code: number | null;
  readonly output: string;
}

// Run a command to completion, capturing stdout+stderr together. Never rejects: a spawn
// failure resolves with code -1 so the asserting test (not the hook) reports it.
function runToEnd(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d) => (output += String(d)));
    child.stderr?.on("data", (d) => (output += String(d)));
    child.on("error", (e) => resolve({ code: -1, output: `${output}\n[spawn error] ${String(e)}` }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

// Every .js file under a directory tree (the client bundle lives under .next/static).
async function jsFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(current, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith(".js")) found.push(p);
    }
  }
  await walk(dir);
  return found;
}

// Read WARTHOG_HMAC_KEY / WARTHOG_DEV_KEK out of .env.example (the committed DEV secrets).
function parseEnvExample(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// ── shared boot state ───────────────────────────────────────────────────────────────────

interface BootContext {
  build: RunResult;
  staticDir: string;
  // boot
  server?: ChildProcess;
  port: number;
  baseUrl: string;
  ready: boolean;
  bootDiag: string;
  serverOutput: () => string;
}

// Secrets that must NEVER appear in the client bundle. Two distinctive values are injected
// into the build environment (so a leak would be caught), plus the repo's committed dev
// secrets. All are valid base64 of the right length, so config validation (if ever reached
// at build) accepts them.
const BUILD_HMAC = randomBytes(48).toString("base64");
const BUILD_KEK = randomBytes(32).toString("base64");

const ctx: BootContext = {
  build: { code: null, output: "" },
  staticDir: join(ROOT, ".next", "static"),
  port: 0,
  baseUrl: "",
  ready: false,
  bootDiag: "",
  serverOutput: () => "",
};

// Poll GET / until the started server answers (any status) or the deadline passes.
async function waitForReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl + "/", { redirect: "manual" });
      return;
    } catch (e) {
      lastErr = String(e);
      await delay(500);
    }
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms (last: ${lastErr})`);
}

describe("production build and boot of the whole app (E18-S12)", () => {
  before(
    async () => {
      // 1) Build the WHOLE app with secrets present in the environment, so the client-bundle
      //    scan (AC4) is meaningful — a leak of a build-env secret would be caught. The build
      //    never connects to a database (route modules load config lazily, per the
      //    conventions), so no DB is needed here.
      ctx.build = await runToEnd("npm", ["run", "build"], {
        ...process.env,
        WARTHOG_HMAC_KEY: BUILD_HMAC,
        WARTHOG_DEV_KEK: BUILD_KEK,
      });

      // Only boot if the build produced a runnable artifact; otherwise the build test reports
      // the failure and the HTTP tests fail on `ctx.ready` with the build output attached.
      if (ctx.build.code !== 0) {
        ctx.bootDiag = `build failed (exit ${ctx.build.code}); not booting.\n${ctx.build.output.slice(-4000)}`;
        return;
      }

      // 2) Boot the started server (`npm start` = `next start`) bound to a non-default PORT.
      //    Development NODE_ENV + PGlite + dev tools so the DB-backed primary journey is
      //    drivable without a real Postgres (see the environment note at the top).
      ctx.port = await freePort();
      ctx.baseUrl = `http://127.0.0.1:${ctx.port}`;

      let output = "";
      ctx.serverOutput = () => output;

      const server = spawn("npm", ["start"], {
        cwd: ROOT,
        detached: true, // own process group, so teardown kills `next` too, not just `npm`
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_ENV: "development",
          PORT: String(ctx.port),
          PUBLIC_BASE_URL: ctx.baseUrl,
          WEBAUTHN_RP_ID: "127.0.0.1",
          DATABASE_URL: "pglite:memory",
          WARTHOG_DEV_TOOLS: "1",
          WARTHOG_HMAC_KEY: BUILD_HMAC,
          WARTHOG_DEV_KEK: BUILD_KEK,
        },
      });
      ctx.server = server;
      server.stdout?.on("data", (d) => (output += String(d)));
      server.stderr?.on("data", (d) => (output += String(d)));

      try {
        await waitForReady(ctx.baseUrl, READY_TIMEOUT_MS);
        ctx.ready = true;
      } catch (e) {
        ctx.ready = false;
        ctx.bootDiag = `${String(e)}\n--- server output (tail) ---\n${output.slice(-4000)}`;
      }
    },
    { timeout: SETUP_TIMEOUT_MS },
  );

  after(async () => {
    const server = ctx.server;
    if (server?.pid) {
      // Kill the whole process group (npm + the next child it spawned).
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        server.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  // ── AC1 — the whole app builds with Next standalone output and no type errors ──────────
  test("npm run build completes with Next standalone output and no type errors", () => {
    assert.equal(
      ctx.build.code,
      0,
      `npm run build must succeed across the whole app (public, auth, portal, oauth, mcp, dev).\n${ctx.build.output.slice(-4000)}`,
    );
    // `next build` type-checks (no ignoreBuildErrors in next.config.mjs) and OBS-025
    // type-checks the generated route types, so exit 0 means no type errors across the app.
    const standaloneServer = join(ROOT, ".next", "standalone", "server.js");
    assert.ok(existsSync(standaloneServer), "next build must emit the standalone server (.next/standalone/server.js)");
    assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "a completed build writes .next/BUILD_ID");
  });

  // ── AC4 — no secret value reaches the client bundle; config is read from env ───────────
  test("[obligation:secrets-from-env] no secret value is present in the client bundle", async () => {
    assert.equal(ctx.build.code, 0, "the build must succeed before the client bundle can be scanned");
    assert.ok(existsSync(ctx.staticDir), "a completed build writes the client bundle under .next/static");

    const envExample = parseEnvExample(await readFile(join(ROOT, ".env.example"), "utf8"));
    // The exact secret VALUES that must never reach the browser: the build-env secrets (so a
    // leak would show) plus the repo's committed dev secrets. Scoped to concrete values, not
    // broad patterns, so the check fails only on a real secret leak.
    const forbidden = [BUILD_HMAC, BUILD_KEK, envExample.WARTHOG_HMAC_KEY, envExample.WARTHOG_DEV_KEK].filter(
      (v): v is string => typeof v === "string" && v.length >= 16,
    );
    assert.ok(forbidden.length >= 2, "expected at least the two injected build secrets to scan for");

    const files = await jsFilesUnder(ctx.staticDir);
    assert.ok(files.length > 0, "the client bundle should contain JavaScript to scan");

    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const secret of forbidden) {
        assert.ok(
          !contents.includes(secret),
          `a secret value leaked into the client bundle: ${file.slice(ROOT.length)}`,
        );
      }
    }
  });

  // ── AC2 + AC5 — npm start binds PORT and serves GET / with 200 and no session ──────────
  test("[obligation:listen-on-port-env] npm start binds the PORT env var and serves GET / with 200 (no session)", async () => {
    assert.ok(ctx.ready, `the started server must boot and serve.\n${ctx.bootDiag}`);
    assert.notEqual(ctx.port, 3000, "the test binds a non-default port, so answering on it proves PORT is honoured");

    const res = await fetch(ctx.baseUrl + "/", { redirect: "manual" });
    assert.equal(res.status, 200, "GET / (landing) returns 200 with no session");
  });

  // ── AC2 — an unauthenticated (portal)/(protected) page redirects to /signin ────────────
  test("an unauthenticated GET of a (portal)/(protected) page redirects to /signin", async () => {
    assert.ok(ctx.ready, `the started server must boot and serve.\n${ctx.bootDiag}`);

    for (const path of ["/home", "/inbox", "/vault"]) {
      const res = await fetch(ctx.baseUrl + path, { redirect: "manual" });
      assert.ok(
        res.status >= 300 && res.status < 400,
        `unauthenticated GET ${path} must redirect (got ${res.status})`,
      );
      const location = res.headers.get("location") ?? "";
      assert.ok(location.includes("/signin"), `${path} must redirect to /signin (got location "${location}")`);
    }
  });

  // ── AC3 + AC4 — the agent/OAuth connector surfaces respond; config comes from env ──────
  test("the agent connector and OAuth authorization server respond over HTTP with config read from env", async () => {
    assert.ok(ctx.ready, `the started server must boot and serve.\n${ctx.bootDiag}`);

    // OAuth authorization-server metadata: a PUBLIC 200 JSON document whose issuer is the
    // configured PUBLIC_BASE_URL — if it were a baked literal it would be localhost:3000, not
    // our chosen origin. This proves config is read from env in the running app.
    const meta = await fetch(ctx.baseUrl + "/.well-known/oauth-authorization-server", { redirect: "manual" });
    assert.equal(meta.status, 200, "the OAuth authorization-server metadata is public and returns 200");
    const metaBody = (await meta.json()) as Record<string, unknown>;
    assert.equal(metaBody.issuer, ctx.baseUrl, "the issuer is taken from PUBLIC_BASE_URL (config from env), not a literal");
    assert.equal(
      metaBody.token_endpoint,
      `${ctx.baseUrl}/oauth/token`,
      "endpoint URLs are derived from the configured base URL",
    );

    // The agent connector endpoint: a POST with no Bearer is rejected 401 and carries the
    // RFC 9728 challenge, proving the MCP auth boundary is live in the running app.
    const mcp = await fetch(ctx.baseUrl + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
    });
    assert.equal(mcp.status, 401, "POST /mcp without a Bearer token is rejected 401");
    assert.ok(
      (mcp.headers.get("www-authenticate") ?? "").length > 0,
      "the 401 carries a WWW-Authenticate challenge",
    );
  });

  // ── AC3 — the primary journey is drivable end-to-end over HTTP ─────────────────────────
  // Sign-up step one (a real data-mutating request) must land a code in the process-wide dev
  // outbox, and /dev/outbox (a PAGE) must show it — which only holds if the sign-up ROUTE
  // handler and the outbox PAGE share ONE outbox singleton across the production build's
  // separate module graphs (OBS-044: verify singletons under next build + next start).
  test("the primary journey is drivable end-to-end over HTTP: a sign-up code lands in the dev outbox", async () => {
    assert.ok(ctx.ready, `the started server must boot and serve.\n${ctx.bootDiag}`);

    const email = `s12-${randomBytes(6).toString("hex")}@warthog.com.au`;
    const sent = await fetch(ctx.baseUrl + "/api/auth/signup/send-code", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.baseUrl },
      body: JSON.stringify({ email }),
      redirect: "manual",
    });
    assert.equal(sent.status, 200, "a well-formed sign-up send-code returns 200 through the running app");

    const outbox = await fetch(ctx.baseUrl + "/dev/outbox", { redirect: "manual" });
    assert.equal(outbox.status, 200, "the dev outbox page is served (dev tools on)");
    const html = await outbox.text();
    assert.ok(
      html.includes(email),
      "the sign-up code reached the dev outbox the page reads — one outbox singleton across route and page graphs",
    );
  });

  // ── AC3 — on boot the in-process job scheduler is started from instrumentation ─────────
  // Instrumentation's register() runs on boot (Node runtime). The started server announces
  // the scheduler on the app's own `[warthog jobs]` log channel, the observable signal a
  // Deploy smoke check needs that the scheduler is running.
  test("on boot the in-process job scheduler is started from instrumentation", { timeout: SCHEDULER_TIMEOUT_MS + 10_000 }, async () => {
    assert.ok(ctx.ready, `the started server must boot and serve.\n${ctx.bootDiag}`);

    const deadline = Date.now() + SCHEDULER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (ctx.serverOutput().includes("[warthog jobs]")) return;
      await delay(500);
    }
    assert.fail(
      `the started server must announce the job scheduler on the [warthog jobs] channel on boot.\n--- server output (tail) ---\n${ctx.serverOutput().slice(-4000)}`,
    );
  });
});
