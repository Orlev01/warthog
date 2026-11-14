// Plain words for the identifiers the admin portal reads (docs/design/admin-portal.md §5):
// metric outcomes and error categories, agent platforms, connector ids, traffic classes.
// Pure; a label the table does not know is title-cased from its identifier so a new
// outcome still reads as words, never as a raw code.

import { agentBrand, serviceBrand } from "../brands";
import type { HostClass, RouteClass } from "../../server/metrics/names";

export function titleCase(identifier: string): string {
  const words = identifier.replace(/[_.-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : identifier;
}

const OUTCOMES: Readonly<Record<string, string>> = {
  executed: "Completed",
  pending_approval: "Waiting for approval",
  refused: "Refused",
  failed: "Failed",
  error: "Error",
  unknown: "Unknown",
  ok: "Succeeded",
  throttled: "Throttled",
  declined: "Declined",
  lapsed: "Lapsed",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  code_sent: "Code sent",
  email_verified: "Email verified",
  factor_enrolled: "Second factor added",
  code_rejected: "Code rejected",
  account_exists: "Account already existed",
};

const CATEGORIES: Readonly<Record<string, string>> = {
  disconnected: "Agent disconnected",
  rate_limited: "Rate limited",
  denied: "Denied by a rule",
  tool_error: "Tool error",
  tool_refused: "Tool refused",
  timeout: "Timed out",
  passkey: "Passkey",
  email_code: "Email code",
  totp: "Authenticator code",
};

export function outcomeLabel(outcome: string): string {
  return OUTCOMES[outcome] ?? titleCase(outcome);
}

export function errorCategoryLabel(category: string): string {
  return CATEGORIES[category] ?? titleCase(category);
}

export function factorLabel(factor: string): string {
  return factor === "totp" ? "Authenticator app" : factor === "passkey" ? "Passkey" : titleCase(factor);
}

export function platformLabel(platform: string): string {
  return agentBrand(platform)?.title ?? titleCase(platform);
}

export function connectorLabel(connectorId: string, lookup?: (id: string) => string | undefined): string {
  return serviceBrand(connectorId)?.title ?? lookup?.(connectorId) ?? titleCase(connectorId);
}

const ROUTES: Readonly<Record<RouteClass, string>> = {
  public: "Public pages",
  auth: "Sign-in and sign-up",
  portal: "Member pages",
  api: "App API",
  mcp: "Agent connector (MCP)",
  oauth: "Agent and service sign-in (OAuth)",
  admin: "Admin portal",
  health: "Health checks",
  other: "Other",
};

const HOSTS: Readonly<Record<HostClass, string>> = { app: "App", admin: "Admin portal", site: "Website", other: "Other hosts" };

export function routeLabel(route: RouteClass): string {
  return ROUTES[route];
}

export function hostLabel(host: HostClass): string {
  return HOSTS[host];
}

export function sweepLabel(name: string): string {
  return titleCase(name);
}
