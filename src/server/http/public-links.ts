// Where the public screens point (docs/adr/website-root-domain.md). `home` is the brand link;
// `account` prefixes the paths only the app serves (/signin, /signup, /recover, /reset).
// Without a separate website both stay relative, which is also what a render test without
// configuration sees.
//
// This module has no runtime imports on purpose: the public components import it, and it must
// never pull the host routing (src/server/http/admin-routing.ts, which names the admin portal's
// internal prefix) into a page's module graph, even if one of them becomes a client component.

import type { Website } from "./website";

export interface PublicLinks {
  readonly home: string;
  readonly account: string;
}

export const RELATIVE_LINKS: PublicLinks = { home: "/", account: "" };

export function publicLinksFor(website: Website | null): PublicLinks {
  return website ? { home: `${website.origin}/`, account: website.appOrigin } : RELATIVE_LINKS;
}
