// Review fix F10 — the health endpoints' testable handler (`/api/health` readiness and
// `/api/health/live` liveness). A `route.ts` may export only the known route keys (OBS-025), so
// the injectable logic lives here and the two thin routes wire the real config loader and the
// process-wide database.
//
// Readiness answers 200 only when this revision can serve: the runtime config loads (production
// refuses an unsafe or incomplete one — dev tools, a pglite database, a missing Key Vault, the
// published dev HMAC key) and the shared database answers a trivial query (`getServerDb()` opens
// it and applies every migration first, so a failed migration fails the probe too). Anything
// else is a 503, so the platform keeps traffic on the previous revision. Liveness answers 200
// whenever the process does, so a database outage never restarts healthy containers.
//
// The responses carry fixed words only — never an error message, which could name a host or a
// user — and are never cached. A failure is logged by check name and error code only.

import type { Db } from "@/server/db/index";

const DEFAULT_TIMEOUT_MS = 3000; // a probe must answer well inside the platform's probe timeout

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export interface HealthDeps {
  // Loads (and so validates) the runtime config; throws when it is unsafe or incomplete.
  readonly loadConfig: () => unknown;
  // The process-wide database, migrated on first use.
  readonly getDb: () => Promise<Db>;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface HealthHandler {
  ready(): Promise<Response>;
  live(): Response;
}

type CheckResult = "ok" | "error" | "skipped";

// Settle `work` within `ms`, or reject.
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// A failure's code (e.g. ECONNREFUSED, a SQLSTATE) — never its message.
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "unknown";
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: HEADERS });
}

export function createHealthHandler(deps: HealthDeps): HealthHandler {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = deps.log ?? ((line: string) => console.error(line));

  return {
    async ready(): Promise<Response> {
      let config: CheckResult = "ok";
      let database: CheckResult = "skipped";
      try {
        deps.loadConfig();
      } catch (error) {
        config = "error";
        // Config errors name the variable and never echo a value, so the message is safe to log.
        log(`[warthog health] config check failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
      if (config === "ok") {
        try {
          await within(
            deps.getDb().then((db) => db.query("SELECT 1")),
            timeoutMs,
          );
          database = "ok";
        } catch (error) {
          database = "error";
          log(`[warthog health] database check failed (${codeOf(error)})`);
        }
      }
      const healthy = config === "ok" && database === "ok";
      return json(healthy ? 200 : 503, {
        status: healthy ? "ok" : "unavailable",
        checks: { config, database },
      });
    },

    live: liveResponse,
  };
}

// Liveness: the process answers. Touches neither config nor the database.
export function liveResponse(): Response {
  return json(200, { status: "ok" });
}
