// Read-side protection — the readable, checked text of one email body, shared by the Gmail
// and Outlook views (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { htmlToText } from "./html-text";
import { cleanText, isSignInLinkText, isSignInUrl, SIGN_IN_LINK_MASK, type CleanOptions, type FilterCounts } from "./text-filters";
import { stripInvisible } from "./untrusted";

/** The most body text an agent is handed (the rest is cut, and the view says so). */
export const MAX_BODY_CHARS = 60_000;

export interface ReadableBody {
  readonly text: string;
  readonly links: readonly string[];
  readonly shortened: boolean;
  /** Elements the sender's own styles hid from the person, dropped. */
  readonly hiddenElements: number;
  /** Links past the listing cap (their text is kept). */
  readonly unlistedLinks: number;
}

// A link is hidden when its address is a sign-in link, or its visible text says it signs in or
// resets a password (click-tracking wrappers hide the real address).
function hideLink(url: string, text: string): boolean {
  return isSignInUrl(url) || isSignInLinkText(text);
}

/** The start of an email's checked text, on one line, like a mail app's own preview. */
export function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199).trimEnd()}…` : flat;
}

/** An email body as an agent reads it: HTML turned into text with numbered links, then checked. */
export function readableBody(content: string, isHtml: boolean, counts: FilterCounts, options: CleanOptions = {}): ReadableBody {
  let text = content;
  let links: readonly string[] = [];
  let hiddenElements = 0;
  let unlistedLinks = 0;
  if (isHtml) {
    const converted = htmlToText(content, { hideLink, hiddenLinkMark: SIGN_IN_LINK_MASK });
    counts.signInLinks += converted.hiddenLinks;
    hiddenElements = converted.hiddenElements;
    unlistedLinks = converted.unlistedLinks;
    text = converted.text;
    links = converted.links.map((link) => {
      const stripped = stripInvisible(link);
      counts.hiddenCharacters += stripped.removed;
      return stripped.text;
    });
  }
  text = cleanText(text, counts, options);
  const shortened = text.length > MAX_BODY_CHARS;
  return { text: shortened ? `${text.slice(0, MAX_BODY_CHARS)}…` : text, links, shortened, hiddenElements, unlistedLinks };
}

const ENCODED_WORD = /=\?([^?\s]{1,40})\?([BbQq])\?([^?\s]{0,1000})\?=/g;

/** Decode RFC 2047 encoded words in a header value ("=?UTF-8?B?...?="), when a provider left them encoded. */
export function decodeHeaderWords(value: string): string {
  if (!value.includes("=?")) return value;
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(ENCODED_WORD, (whole, charset: string, encoding: string, data: string) => {
      try {
        const bytes = encoding.toUpperCase() === "B" ? base64Bytes(data) : quotedPrintableWordBytes(data);
        return decodeBytes(bytes, charset);
      } catch {
        return whole;
      }
    });
}

function quotedPrintableWordBytes(data: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]!;
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
      out.push(parseInt(data.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Bytes from base64 or base64url text (padding optional). Throws on anything else. */
export function base64Bytes(data: string): Uint8Array {
  const normal = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normal)) throw new Error("not base64");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes as text in the named charset, falling back to UTF-8 for an unknown one. */
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().replace(/^"|"$/g, "") || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
