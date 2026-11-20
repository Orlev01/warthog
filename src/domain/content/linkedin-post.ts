// A LinkedIn post, built by Warthog from an agent's plain fields (docs/adr/linkedin-connector.md).
//
// Pure domain module: no React, no DB, no clock. The approval card and the post are built from
// the SAME input, so what the person approves is exactly what is posted (the approval-card truth
// rule, docs/adr/approval-card-truth.md). LinkedIn reads a post's text as "little" text, where
// some characters are markup (a mention, a template); unescaped, they can cut the rest of the
// post off, so every one of them is escaped except the # of a hashtag.
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format

import { stripInvisible } from "./untrusted";

/** LinkedIn's limit on a post's text. */
export const MAX_POST_CHARS = 3000;
const EXCERPT_CHARS = 280;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_LINK_CHARS = 2000;

export type PostVisibility = "PUBLIC" | "CONNECTIONS";

/** What an agent asks to post. */
export interface LinkedInPostInput {
  readonly text: string;
  readonly visibility?: PostVisibility;
  readonly link?: { readonly url: string; readonly title?: string; readonly description?: string };
}

/** A post Warthog won't send, with the reason in plain words for the agent. */
export class LinkedInPostError extends Error {}

/** The text a post goes out with: exactly what the card shows. */
export function postText(text: string): string {
  return stripInvisible(text).text.trim();
}

/** The text in LinkedIn's "little" format: reserved characters escaped, hashtags kept. */
export function littleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (ch, at: number) =>
    ch === "#" && /^\p{L}/u.test(text.slice(at + 1)) ? ch : `\\${ch}`);
}

// A link LinkedIn can show: https, a real public host name, no sign-in details in it.
function checkedLink(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LinkedInPostError("link.url must be a full https address.");
  }
  // A name, not an address: no IPv4 (all digits and dots) and no IPv6 ([…] holds colons).
  const host = parsed.hostname;
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || url.length > MAX_LINK_CHARS
    || !host.includes(".") || /^[0-9.]+$/.test(host) || host.includes(":")) {
    throw new LinkedInPostError("link.url must be a public https address with no sign-in details.");
  }
  return parsed;
}

function domainOf(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

function capped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The text, checked: it has words and fits LinkedIn's limit.
function checkedText(text: string): string {
  const out = postText(text);
  if (!out) throw new LinkedInPostError("A post needs some text.");
  if (out.length > MAX_POST_CHARS) throw new LinkedInPostError(`A LinkedIn post can be at most ${MAX_POST_CHARS} characters.`);
  return out;
}

/** The Posts API body for a member's post (POST https://api.linkedin.com/rest/posts). */
export function buildLinkedInPost(memberId: string, input: LinkedInPostInput): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(memberId)) throw new LinkedInPostError("LinkedIn didn't say which member this is.");
  const text = checkedText(input.text);
  const body: Record<string, unknown> = {
    author: `urn:li:person:${memberId}`,
    commentary: littleText(text),
    visibility: input.visibility ?? "CONNECTIONS",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.link) {
    const url = checkedLink(input.link.url);
    const title = postText(input.link.title ?? "") || domainOf(url);
    const description = postText(input.link.description ?? "");
    body.content = {
      article: {
        source: input.link.url,
        title: capped(title, MAX_TITLE_CHARS),
        ...(description ? { description: capped(description, MAX_DESCRIPTION_CHARS) } : {}),
      },
    };
  }
  return body;
}

/** What the approval card shows for a post. */
export interface OutgoingPost {
  readonly kind: "post";
  readonly excerpt: string;
  readonly text: string;
  readonly visibility: PostVisibility;
  readonly link?: string;
  readonly linkDomain?: string;
}

/** The card's summary of a post, from the same input the post is built from. */
export function outgoingPost(input: LinkedInPostInput): OutgoingPost {
  const text = postText(input.text);
  const flat = text.replace(/\s+/g, " ");
  let link: URL | undefined;
  try {
    link = input.link ? checkedLink(input.link.url) : undefined;
  } catch {
    link = undefined;
  }
  return {
    kind: "post",
    excerpt: capped(flat, EXCERPT_CHARS),
    text: capped(text, MAX_POST_CHARS),
    visibility: input.visibility ?? "CONNECTIONS",
    ...(link ? { link: capped(input.link!.url, MAX_LINK_CHARS), linkDomain: domainOf(link) } : {}),
  };
}

/** A post's id as LinkedIn returns it (`x-restli-id`). */
export function isLinkedInPostUrn(id: string): boolean {
  return /^urn:li:(?:share|ugcPost):[0-9]{1,40}$/.test(id);
}

/** Where the person can open a post. */
export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}
