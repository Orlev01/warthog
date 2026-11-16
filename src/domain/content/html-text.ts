// Read-side protection — the readable text of an HTML email or document
// (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now. Runtime
// dependencies are frozen (CLAUDE.md), so this is a small hand-written scanner rather than a
// parser library. It walks the markup once, front to back (every search moves forward), so
// unclosed or adversarial markup cannot make it slow.
//
// What it keeps: the text a person reads, line breaks where blocks end, and link targets,
// numbered — "Track your parcel [2]" with link 2 listed — so an agent can still give the
// person the tracking, booking, Zoom or unsubscribe link. What it drops: scripts, styles, the
// head, comments, SVG and embedded frames; elements hidden with inline styles (the usual way
// to hide text from the person but not from a model); and every image URL (an image URL can
// carry data out when a client renders it) — an image keeps only its alt text.

/** The readable text of some HTML and the link targets it numbers. */
export interface HtmlText {
  readonly text: string;
  readonly links: readonly string[];
  /** Links the caller asked to hide (sign-in links), replaced in the text by `hiddenLinkMark`. */
  readonly hiddenLinks: number;
  /** Elements dropped because their styles hid them from the reader. */
  readonly hiddenElements: number;
  /** Links not listed because the message had more than MAX_LINKS. */
  readonly unlistedLinks: number;
}

export interface HtmlTextOptions {
  /** Return true to hide a link from the reader (e.g. a sign-in link), given its address and visible text. */
  readonly hideLink?: (url: string, text: string) => boolean;
  /** What a hidden link reads as in the text. */
  readonly hiddenLinkMark?: string;
}

/** The most links one document lists (the rest keep their text, without a number). */
export const MAX_LINKS = 200;

// Elements whose whole content is never read by a person.
const SKIP_CONTENT = new Set([
  "script", "style", "title", "template", "noscript", "svg", "iframe", "object", "xml", "math",
]);

// Elements that cannot contain anything (so a hidden one hides nothing).
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

// Elements that end a line of text.
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "center", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "thead", "tfoot", "tr", "ul",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", bull: "•", middot: "·", euro: "€", pound: "£",
  cent: "¢", yen: "¥", deg: "°", times: "×", divide: "÷", laquo: "«", raquo: "»", para: "¶",
  sect: "§", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", iexcl: "¡", iquest: "¿",
  shy: "­", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", agrave: "à", egrave: "è",
  ograve: "ò", auml: "ä", euml: "ë", ouml: "ö", uuml: "ü", ntilde: "ñ", ccedil: "ç", szlig: "ß",
  Aacute: "Á", Eacute: "É", Ouml: "Ö", Uuml: "Ü", Auml: "Ä",
};

const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/** Decode HTML character references (named, decimal and hex). Unknown names are kept as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// One tag's attributes, read in order (so `title=" href=decoy"` is a title, not an href).
const ATTRIBUTE = /\s([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const afterName = tag.replace(/^<\/?[A-Za-z][A-Za-z0-9:-]*/, "");
  for (const match of afterName.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim());
  }
  return out;
}

// Inline styles that hide an element from the reader. (`mso-hide` hides from Outlook only and
// so is NOT hiding: the other version of that content is what everyone else sees.)
const HIDING_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$|!)|max-height\s*:\s*0(?:px)?\s*(?:;|$|!))/i;
// A zero font size hides text only on an inline element. Email builders (MJML and others) set
// it on every layout block to close the gaps between columns, then reset it inside, so on a
// div or table cell it hides nothing.
const ZERO_FONT = /(?:^|;)\s*font-size\s*:\s*0(?:\.\d+)?(?:px|pt|em|rem|%)?\s*(?:;|$|!)/i;
const INLINE_TEXT = new Set(["span", "font", "a", "b", "strong", "i", "em", "small", "u", "s", "sub", "sup", "label", "mark"]);

function hidesContent(name: string, attrs: Map<string, string>): boolean {
  if (attrs.has("hidden")) return true;
  if (attrs.get("aria-hidden")?.toLowerCase() === "true" && !attrs.has("alt")) return true;
  const style = attrs.get("style");
  if (style === undefined) return false;
  return HIDING_STYLE.test(style) || (INLINE_TEXT.has(name) && ZERO_FONT.test(style));
}

// Where a tag that starts at `start` ends (the index of its `>`), respecting quoted
// attribute values within MAX_TAG characters; a stray quote falls back to the first `>`.
// -1 when it never closes.
function tagEnd(html: string, start: number): number {
  let quote: string | null = null;
  const limit = Math.min(html.length, start + MAX_TAG);
  for (let i = start + 1; i < limit; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return html.indexOf(">", start + 1);
}

// The next `</name` that really closes `name` (not `</header>` for `head`), from `from`.
function closingTag(lower: string, name: string, from: number): number {
  let at = lower.indexOf(`</${name}`, from);
  while (at >= 0) {
    const next = lower[at + name.length + 2];
    if (next === undefined || next === ">" || next === "/" || /\s/.test(next)) return at;
    at = lower.indexOf(`</${name}`, at + 1);
  }
  return -1;
}

const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9:-]{0,40})/;
// A tag longer than this is treated as broken markup and skipped whole.
const MAX_TAG = 16_384;

/** The readable text of `html`, with links numbered, hidden elements dropped and image URLs dropped. */
export function htmlToText(html: string, options: HtmlTextOptions = {}): HtmlText {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  const links: string[] = [];
  const linkNumbers = new Map<string, number>();
  let hiddenLinks = 0;
  let hiddenElements = 0;
  let unlistedLinks = 0;
  // The open anchor: its address and where its visible text starts in `parts`.
  let anchor: { href: string; from: number } | null = null;
  // While inside a hidden element: its name and how many same-named elements are open within it.
  let hidden: { name: string; depth: number } | null = null;
  let i = 0;

  const emit = (text: string) => {
    if (!hidden) parts.push(text);
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      emit(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) emit(decodeEntities(html.slice(i, lt)));

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const close = html.indexOf(">", lt + 2);
      i = close < 0 ? html.length : close + 1;
      continue;
    }

    const nameMatch = TAG_NAME.exec(html.slice(lt, lt + 44));
    if (!nameMatch) {
      // A bare "<" in text.
      emit("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end < 0 || end - lt > MAX_TAG * 4) {
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const tag = html.slice(lt, end + 1);
    const name = nameMatch[1]!.toLowerCase();
    const closing = tag[1] === "/";
    const selfClosing = tag.endsWith("/>") || VOID.has(name);
    i = end + 1;

    // The head ends at </head> or, when that optional tag is missing, where the body starts.
    if (name === "head" && !closing) {
      const close = closingTag(lower, "head", i);
      const body = lower.indexOf("<body", i);
      const stop = close >= 0 && (body < 0 || close < body) ? close : body;
      if (stop < 0) {
        i = html.length;
      } else {
        const stopEnd = html.indexOf(">", stop);
        i = stop === body ? stop : stopEnd < 0 ? html.length : stopEnd + 1;
      }
      continue;
    }
    if (!closing && SKIP_CONTENT.has(name) && !tag.endsWith("/>")) {
      const close = closingTag(lower, name, i);
      if (close < 0) {
        i = html.length;
      } else {
        const closeEnd = html.indexOf(">", close);
        i = closeEnd < 0 ? html.length : closeEnd + 1;
      }
      continue;
    }

    // Inside a hidden element nothing is read; only its own nesting is tracked.
    if (hidden) {
      if (name === hidden.name && !selfClosing) {
        if (closing) {
          hidden.depth -= 1;
          if (hidden.depth === 0) hidden = null;
        } else {
          hidden.depth += 1;
        }
      }
      continue;
    }

    if (!closing && !selfClosing && hidesContent(name, attributes(tag))) {
      hidden = { name, depth: 1 };
      hiddenElements += 1;
      continue;
    }

    if (name === "a") {
      if (closing) {
        if (anchor) {
          const text = parts.slice(anchor.from).join("");
          if (options.hideLink?.(anchor.href, text)) {
            hiddenLinks += 1;
            parts.push(` ${options.hiddenLinkMark ?? "[link hidden]"}`);
          } else {
            let number = linkNumbers.get(anchor.href);
            if (number === undefined && links.length < MAX_LINKS) {
              links.push(anchor.href);
              number = links.length;
              linkNumbers.set(anchor.href, number);
            }
            if (number === undefined) unlistedLinks += 1;
            else parts.push(` [${number}]`);
          }
        }
        anchor = null;
      } else {
        const href = attributes(tag).get("href");
        anchor = href && /^(?:https?:|mailto:)/i.test(href) ? { href, from: parts.length } : null;
      }
      continue;
    }

    if (name === "img" && !closing) {
      const alt = attributes(tag).get("alt");
      if (alt && alt.length <= 120) parts.push(` [image: ${alt}] `);
      continue;
    }

    if (name === "li" && !closing) {
      parts.push("\n- ");
      continue;
    }
    if (BLOCK.has(name)) {
      parts.push("\n");
      continue;
    }
    if (name === "td" || name === "th") {
      parts.push(" ");
      continue;
    }
  }

  const text = parts
    .join("")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, links, hiddenLinks, hiddenElements, unlistedLinks };
}
