// Read-side protection — the default check over any service's JSON reply
// (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
//
// Every service result an agent reads is walked once: each text value is checked (hidden
// characters, sign-in links, sign-in codes, card numbers), identifiers are only stripped of
// hidden characters (an id is never "masked"), and pre-authenticated download links — a
// ready-made way to hand a file to anyone — are dropped. Numbers, booleans and the shape of
// the reply are left exactly as the service sent them.
//
// The person's level (read-levels.ts) changes this: at "open" nothing is masked or dropped
// (hidden characters are still removed); at "private" a value whose key names an account or
// ID number ("accountNumber", "bsb", "memberNo") is also hidden, number or text.

import { cleanText, IDENTIFIER_MASK, isSignInUrl, SIGN_IN_LINK_MASK, type CleanOptions, type FilterCounts } from "./text-filters";
import { stripInvisible } from "./untrusted";

/** What the default check counted, beyond the text filters. */
export interface JsonCleanCounts extends FilterCounts {
  downloadLinks: number;
}

// Keys whose values are identifiers, timestamps, addresses or opaque tokens: never prose.
const ID_KEY_EXACT = /^(?:id|ids|etag|e_tag|kind|key|uuid|guid|href|url|uri|self|link|icaluid|historyid|internaldate|sizeestimate|mimetype|contenttype|cursor|next_cursor|created|updated|datetime|date|timezone|time_zone|status|state|type|version|sequence|format)$/i;
// camelCase / snake_case identifier suffixes (case-sensitive, so a prose key like "chat" is not caught).
const ID_KEY_SUFFIX = /(?:Id|_id|Ids|_ids|Token|_token|Time|DateTime|Url|_url|Uri|Link|_link|At|_at|Tag)$/;
const LINK_KEY = /(?:url|uri|link|href)$/i;
// Keys holding a pre-authenticated download address for the item itself.
const DOWNLOAD_KEY = /^@(?:microsoft\.graph|content)\.downloadurl$/i;
// Keys (lower-cased, letters only) naming a number that identifies the person or an account,
// for the private level. Never an id the service needs back ("accountId", "customer_id").
const IDENTIFIER_KEY = /^(?:(?:bank)?(?:account|acct)(?:number|no|num)|bsb|tfn|taxfile(?:number|no)|medicare(?:card)?(?:number|no)?|passport(?:number|no)?|(?:drivers?)?licen[cs]e(?:number|no)?|(?:member(?:ship)?|policy|customer|card)(?:number|no|num))$/;

// Whether a value under `key` is an identifying number the private level hides: at least
// three digits, under a key that names one.
function isIdentifierValue(key: string | undefined, value: string | number): boolean {
  if (key === undefined || !IDENTIFIER_KEY.test(key.toLowerCase().replace(/[^a-z]/g, ""))) return false;
  return (String(value).match(/\d/g)?.length ?? 0) >= 3;
}

const MAX_DEPTH = 40;

function walk(value: unknown, key: string | undefined, depth: number, counts: JsonCleanCounts, options: CleanOptions): unknown {
  const open = options.level === "open";
  if (options.level === "private" && (typeof value === "string" || typeof value === "number") && isIdentifierValue(key, value)) {
    counts.identifiers += 1;
    return IDENTIFIER_MASK;
  }
  if (typeof value === "string") {
    if (key !== undefined && (ID_KEY_EXACT.test(key) || ID_KEY_SUFFIX.test(key))) {
      const stripped = stripInvisible(value);
      counts.hiddenCharacters += stripped.removed;
      if (!open && LINK_KEY.test(key) && isSignInUrl(stripped.text)) {
        counts.signInLinks += 1;
        return SIGN_IN_LINK_MASK;
      }
      return stripped.text;
    }
    return cleanText(value, counts, options);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[too deeply nested for Warthog to check]";
  if (Array.isArray(value)) return value.map((item) => walk(item, key, depth + 1, counts, options));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!open && DOWNLOAD_KEY.test(k)) {
      counts.downloadLinks += 1;
      continue;
    }
    out[k] = walk(v, k, depth + 1, counts, options);
  }
  return out;
}

/** Check every text value in a parsed JSON reply. */
export function cleanJson(value: unknown, counts: JsonCleanCounts, options: CleanOptions = {}): unknown {
  return walk(value, undefined, 0, counts, options);
}
