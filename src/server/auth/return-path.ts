// The return path after signing in (review fix B6). A flow started while signed out —
// an agent's connection request (/oauth/authorize), an approval link (/a/<token>), a
// household invite — sends the person to `/signin?next=<relative path>`. Sign-in,
// sign-up, recovery and new-device sign-in then go back to that path instead of /home.
//
// `next` arrives from the URL, so it is untrusted: followed blindly it is an open
// redirect (`//evil.example`), a script (`javascript:`), or a header-smuggling vector.
// `safeReturnPath` keeps a value only when it is unmistakably a path on this site and
// otherwise answers the default, /home:
//   • a single string of at most 2,048 characters;
//   • starting with exactly one "/" (not "//", not "/\"), with no backslash and no
//     control character anywhere;
//   • resolving, against a placeholder origin, to that same origin (so no scheme or host
//     can sneak in through any parser quirk);
//   • not one of the auth screens themselves (no sign-in loops).
// The kept value is re-serialised from the parsed URL (path, query, fragment), and that
// serialised value must still start with exactly one "/".
//
// Pure and dependency-free, so the server pages and the client flows share it.

export const DEFAULT_RETURN_PATH = "/home";

const MAX_RETURN_PATH_LENGTH = 2048;
const PLACEHOLDER_ORIGIN = "https://return-path.invalid";

// The auth screens: returning to one of them after signing in would loop.
const AUTH_SCREENS = new Set(["/signin", "/signup", "/recover", "/device"]);

export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_RETURN_PATH;
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) return DEFAULT_RETURN_PATH;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_RETURN_PATH;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_RETURN_PATH;

  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return DEFAULT_RETURN_PATH;

  // Parsing collapses dot segments (`/.//x`, `/%2e//x`, `/a/..//x` → `//x`), so the
  // re-serialised value gets the leading-slash checks again: a browser would read a
  // `//host` pathname as another site.
  const kept = `${url.pathname}${url.search}${url.hash}`;
  if (kept.startsWith("//") || kept.startsWith("/\\")) return DEFAULT_RETURN_PATH;

  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (AUTH_SCREENS.has(path)) return DEFAULT_RETURN_PATH;

  return kept;
}

// An auth-screen link that carries the return path along (so moving from sign-in to
// sign-up, recovery or new-device sign-in keeps where the person was going). The
// default return path is left off, and an unsafe value is dropped.
export function withReturnPath(href: string, returnTo: string | undefined): string {
  const safe = safeReturnPath(returnTo);
  if (safe === DEFAULT_RETURN_PATH) return href;
  return `${href}?next=${encodeURIComponent(safe)}`;
}

// Whether sign-in was asked to show its form even to a visitor who is already signed in
// (`?fresh=1`), rather than forwarding them to the return path: the person proves it's them
// again and the new session carries a fresh step-up. Only the exact value "1" counts.
export function wantsFreshSignIn(raw: unknown): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1";
}
