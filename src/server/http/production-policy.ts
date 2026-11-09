import { isIP } from "node:net";

export function ingressClientIp(forwarded: string | null): string {
  const last = forwarded?.split(",").at(-1)?.trim() ?? "";
  if (isIP(last)) return last;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(last)?.[1];
  if (bracketed && isIP(bracketed)) return bracketed;
  const v4 = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(last)?.[1];
  return v4 && isIP(v4) ? v4 : "unknown";
}

// Azure ingress appends the client address at the right. Missing/malformed values
// share a conservative bucket; an attacker cannot create arbitrary fallback keys.
export function createAuthIpLimiter(limits = { requests: 60, windowMs: 60_000, maxClients: 10_000 }) {
  const clients = new Map<string, { count: number; expires: number }>();
  return { allow(forwarded: string | null, now: number): boolean {
    for (const [key, entry] of clients) if (entry.expires <= now) clients.delete(key);
    const key = ingressClientIp(forwarded);
    let entry = clients.get(key);
    if (!entry) {
      if (clients.size >= limits.maxClients) return false;
      entry = { count: 0, expires: now + limits.windowMs }; clients.set(key, entry);
    }
    if (entry.count >= limits.requests) return false;
    entry.count++; return true;
  } };
}

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return ["default-src 'self'", `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
    `connect-src 'self'${development ? " ws: wss:" : ""}`, "worker-src 'self'", "manifest-src 'self'",
    "frame-src 'none'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join("; ");
}
