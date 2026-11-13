// Traffic counting without personal data (docs/design/admin-portal.md §4). The proxy sees
// every request first, so it COUNTS each one into a process-wide aggregator keyed only by
// closed vocabularies — which host class, which route class (from a fixed prefix table,
// never the path itself), and whether it was a document navigation, another fetch or a
// rate-limited refusal. No path, query, IP, user agent or cookie is ever stored. The
// `traffic-flush` sweep drains the counter once a minute into metric_events as
// `http.requests` rows whose outcome is `<host>.<route>.<kind>`, through the guarded
// recorder. The app runs one replica, so one counter is complete; a restart loses at most
// a minute. The proxy cannot see response status codes; those live in Azure ingress metrics.

import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { processSingleton } from "../seams/process-singleton";
import { recordMetricEvent } from "../metrics/record";
import { HTTP_REQUESTS, trafficLabel, type HostClass, type RequestKind, type RouteClass } from "../metrics/names";

// Route classes by path prefix, first match wins. Lookalikes are excluded by the segment
// boundary check in `classifyRoute`.
const PREFIXES: readonly (readonly [RouteClass, readonly string[]])[] = [
  ["health", ["/api/health"]],
  ["auth", ["/signin", "/signup", "/recover", "/reset", "/device", "/api/auth"]],
  ["oauth", ["/oauth", "/connect"]],
  ["mcp", ["/mcp", "/.well-known"]],
  ["api", ["/api"]],
  ["admin", ["/admin"]],
  ["public", ["/help", "/privacy", "/terms"]],
  ["portal", ["/home", "/inbox", "/activity", "/agents", "/more", "/vault", "/connectors", "/rules", "/spending", "/skills", "/memory", "/life-admin", "/household", "/settings", "/a"]],
];

function owns(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The route class of a pathname (never the path itself). The root is `public`. */
export function classifyRoute(pathname: string): RouteClass {
  if (pathname === "/") return "public";
  for (const [route, prefixes] of PREFIXES) {
    if (prefixes.some((prefix) => owns(prefix, pathname))) return route;
  }
  return "other";
}

/** A document navigation (the browser loading a page), any other request, or a refusal. */
export function requestKind(headers: Headers, limited: boolean): RequestKind {
  if (limited) return "limited";
  const dest = headers.get("sec-fetch-dest");
  const mode = headers.get("sec-fetch-mode");
  return dest === "document" || mode === "navigate" ? "document" : "fetch";
}

export interface TrafficCounter {
  count(host: HostClass, route: RouteClass, kind: RequestKind): void;
  /** The counts so far, as metric labels, and reset. */
  drain(): readonly { readonly label: string; readonly count: number }[];
}

export function createTrafficCounter(): TrafficCounter {
  const counts = new Map<string, number>();
  return {
    count(host, route, kind) {
      const label = trafficLabel(host, route, kind);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    },
    drain() {
      const drained = [...counts.entries()].map(([label, count]) => ({ label, count }));
      counts.clear();
      return drained;
    },
  };
}

/** The process-wide counter the proxy increments and the flush sweep drains. */
export function getTrafficCounter(): TrafficCounter {
  return processSingleton("http.trafficCounter", createTrafficCounter);
}

/** Record every drained count as one `http.requests` event; an empty counter records nothing. */
export async function flushTraffic(db: Db, clock: Clock, counter: TrafficCounter = getTrafficCounter()): Promise<number> {
  const drained = counter.drain();
  for (const { label, count } of drained) {
    if (count <= 0) continue;
    await recordMetricEvent(db, clock, { name: HTTP_REQUESTS, value: count, dimensions: { outcome: label } });
  }
  return drained.length;
}
