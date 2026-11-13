// Where the admin portal lives, derived — never configured in production — from the
// public base URL (docs/design/admin-portal.md §1): `app.<domain>` → `admin.<domain>`;
// any other host gains an `admin.` label; scheme and port carry over. Deriving it keeps
// the Azure release image-only: no new environment variable, and the deploy script's
// exact PUBLIC_BASE_URL / RP ID check stays untouched.
//
// Pure functions over strings and Headers, no I/O, no process.env (config.ts is the only
// module that reads the environment; it calls adminOriginFor with the parsed value).

const APP_LABEL = /^app\./i;

/** The admin origin for a public base URL, or null when the URL does not parse. */
export function adminOriginFor(publicBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const adminHost = APP_LABEL.test(host) ? host.replace(APP_LABEL, "admin.") : `admin.${host}`;
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${adminHost}${port}`;
}

/** The lower-cased hostname of an absolute URL, or null when it does not parse. */
export function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

// Strip a port from a host header value, keeping a bracketed IPv6 literal intact.
function withoutPort(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * The hostname a request arrived on: the ingress's `x-forwarded-host` (first value) when
 * present, else `host`; lower-cased, port stripped; null when neither header is set.
 */
export function requestHostname(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0];
  const raw = forwarded && forwarded.trim() ? forwarded : headers.get("host");
  if (!raw || !raw.trim()) return null;
  return withoutPort(raw).toLowerCase();
}
