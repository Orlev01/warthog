// The public website's own host (docs/adr/website-root-domain.md). When the app lives at
// `app.<domain>`, the front door, Help, Privacy and Terms are also served from `<domain>`,
// `www.<domain>` forwards there, and every other path on the website host forwards to the app.
// Like the admin origin it is derived from PUBLIC_BASE_URL, never configured, so the
// release stays image-only. Any other public base URL (localhost, a bare domain) has no
// separate website: the app's root shows the front door, as before.
//
// Pure functions over strings, no I/O and no process.env (config.ts reads the environment
// and calls websiteFor with the parsed value). The proxy only narrows what a host serves;
// every redirect target is an origin from here, never the request's own Host header.

import { isAssetPath } from "./admin-routing";

const APP_LABEL = /^app\./i;

export interface Website {
  /** The website origin, e.g. https://warthog.com.au. */
  readonly origin: string;
  /** Its hostname, and the www. name that forwards to it. */
  readonly host: string;
  readonly wwwHost: string;
  /** The app origin (the public base URL's), where accounts, agents and the API live. */
  readonly appOrigin: string;
}

/** The website for a public base URL `app.<domain>`, or null when there is none. */
export function websiteFor(publicBaseUrl: string): Website | null {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const appHost = url.hostname.toLowerCase();
  if (!APP_LABEL.test(appHost)) return null;
  const host = appHost.replace(APP_LABEL, "");
  if (!host.includes(".") && host !== "localhost") return null;
  const port = url.port ? `:${url.port}` : "";
  return {
    origin: `${url.protocol}//${host}${port}`,
    host,
    wwwHost: `www.${host}`,
    appOrigin: `${url.protocol}//${appHost}${port}`,
  };
}

// The paths the website host serves itself. Everything public a visitor reads before
// signing in; nothing that needs a session or the app's cookies.
export function isWebsitePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/help" || pathname.startsWith("/help/")
    || pathname === "/privacy" || pathname === "/terms";
}

export type WebsiteRoute =
  | { readonly kind: "elsewhere" }
  | { readonly kind: "website" }
  | { readonly kind: "passthrough" }
  | { readonly kind: "redirect"; readonly origin: string };

// The development server's own endpoints (error overlay, stack frames), so a local website
// host stays usable; production serves nothing under this prefix.
const DEV_PREFIX = "/__nextjs";

export function routeForWebsite(hostname: string | null, website: Website | null, pathname: string): WebsiteRoute {
  if (website === null || hostname === null) return { kind: "elsewhere" };
  if (hostname === website.wwwHost) return { kind: "redirect", origin: website.origin };
  if (hostname !== website.host) return { kind: "elsewhere" };
  if (isAssetPath(pathname) || pathname.startsWith(DEV_PREFIX)) return { kind: "passthrough" };
  return isWebsitePath(pathname) ? { kind: "website" } : { kind: "redirect", origin: website.appOrigin };
}

/**
 * The absolute redirect target: the same path and query on `origin`. The path is set as a
 * pathname, never parsed as a URL, so `//elsewhere.example` stays on `origin`.
 */
export function redirectTarget(origin: string, pathname: string, search: string): URL {
  const target = new URL(origin);
  target.pathname = pathname;
  target.search = search;
  return target;
}
