// The metric vocabulary the admin portal reads and the instrumented code paths write
// (docs/design/admin-portal.md §4): one source of truth for every name and dimension
// label, so a writer and the portal's reads can never drift apart. Every label is a short
// identifier the guarded recorder (./record.ts) accepts; none can carry personal content.

// Existing names (recorded before the portal existed).
export const AGENT_REQUEST = "agent.request";
export const AGENT_REQUEST_LATENCY = "agent.request.latency_ms";
export const APPROVAL_DECISION = "approval.decision";
export const APPROVAL_RESPONSE_TIME = "approval.response_time_ms";
export const INTEGRITY_CHECK = "integrity.check";
export const USERS_TOTAL = "users.total";
export const HOUSEHOLDS_TOTAL = "households.total";
export const AGENTS_ACTIVE = "agents.active";
export const CONNECTOR_CONNECTIONS = "connector.connections";
export const CONNECTOR_FAILURES = "connector.failures";

// Added for the portal.
export const SIGNUP_STEP = "signup.step";
export const SIGNUP_COMPLETED = "signup.completed";
export const SIGNIN_ATTEMPT = "signin.attempt";
export const CONNECTOR_CONNECT = "connector.connect";
export const CONNECTOR_REFRESH = "connector.refresh";
export const JOB_FAILURE = "job.failure";
export const ACCOUNT_DELETED = "account.deleted";
export const AGENT_TOKEN = "agent.token";
export const HTTP_REQUESTS = "http.requests";
export const ADMIN_HANDOFF = "admin.handoff";
export const ADMIN_SESSION = "admin.session";
export const ADMIN_SIGNOUT = "admin.signout";
export const ADMIN_LOOKUP = "admin.lookup";

// Dimension labels, grouped by the metric that carries them.
export const SIGNUP_STEPS = {
  codeSent: "code_sent",
  throttled: "throttled",
  emailVerified: "email_verified",
  codeRejected: "code_rejected",
  factorEnrolled: "factor_enrolled",
} as const;
export const SIGNUP_OUTCOMES = { ok: "ok", accountExists: "account_exists" } as const;
export const FACTORS = { passkey: "passkey", totp: "totp" } as const;
export const SIGNIN_OUTCOMES = { ok: "ok", failed: "failed", throttled: "throttled" } as const;
export const SIGNIN_CATEGORIES = { passkey: "passkey", emailCode: "email_code", totp: "totp" } as const;
export const CONNECT_OUTCOMES = { ok: "ok", failed: "failed", declined: "declined" } as const;
export const REFRESH_OUTCOMES = { ok: "ok", failed: "failed", lapsed: "lapsed" } as const;
export const ADMIN_HANDOFF_OUTCOMES = { minted: "minted", stepUpRequired: "step_up_required", notAdmin: "not_admin" } as const;
export const ADMIN_SESSION_OUTCOMES = { exchanged: "exchanged", rejected: "rejected" } as const;
export const ADMIN_LOOKUP_OUTCOMES = { found: "found", none: "none" } as const;

// Traffic labels: `<host>.<route>.<kind>` in the outcome dimension (closed vocabularies).
export const HOST_CLASSES = ["app", "admin", "site", "other"] as const;
export const ROUTE_CLASSES = ["public", "auth", "portal", "api", "mcp", "oauth", "admin", "health", "other"] as const;
export const REQUEST_KINDS = ["document", "fetch", "limited"] as const;
export type HostClass = (typeof HOST_CLASSES)[number];
export type RouteClass = (typeof ROUTE_CLASSES)[number];
export type RequestKind = (typeof REQUEST_KINDS)[number];

export function trafficLabel(host: HostClass, route: RouteClass, kind: RequestKind): string {
  return `${host}.${route}.${kind}`;
}

// The inverse of trafficLabel for the portal's reads; null for a label outside the vocabulary.
export function parseTrafficLabel(label: string | null): { host: HostClass; route: RouteClass; kind: RequestKind } | null {
  if (!label) return null;
  const [host, route, kind] = label.split(".");
  if (!HOST_CLASSES.includes(host as HostClass) || !ROUTE_CLASSES.includes(route as RouteClass) || !REQUEST_KINDS.includes(kind as RequestKind)) return null;
  return { host: host as HostClass, route: route as RouteClass, kind: kind as RequestKind };
}
