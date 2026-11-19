// Branded emails: one structured model and one renderer for every email Warthog sends.
//
// A caller describes WHAT an email says (`EmailContent`: a short subject, a heading, one to
// three short paragraphs, and optionally a one-time code, a button and a footnote) and this
// module decides how it looks. `renderEmail` turns that into the three parts a provider
// sends: the subject, an email-safe HTML body (tables, inline styles, no web fonts, no
// external CSS, no tracking) and a plain-text body that carries everything the HTML does.
//
// A message that carries no `email` content still looks right: `emailContentOf` gives it a
// generic layout (subject "Warthog", its `body` as the paragraph, its `link` as an "Open
// Warthog" button), so a sender nobody migrated is never a bare string.
//
// Security rules (a reviewer veto):
//   • every interpolated string is HTML-escaped (& < > " ') — copy, untrusted names, URLs;
//   • only a URL that parses as https: (or http: on localhost / 127.0.0.1 for development)
//     becomes an href; anything else renders as plain text with no link;
//   • the subject is one line and never carries the code, the link or any URL;
//   • the inbox preview (preheader) is the first paragraph, never the code;
//   • redaction happens in the caller, before content reaches a sender, as for `body`.

import type { OutgoingMessage } from "./senders";

export interface EmailAction {
  readonly label: string;
  readonly url: string;
}

export interface EmailContent {
  // Specific and short ("Your Warthog verification code", "New passkey added"). Never a
  // code, token or link: the renderer refuses one.
  readonly subject: string;
  // The H1.
  readonly heading: string;
  // One to three short paragraphs of plain text. The first is also the inbox preview.
  readonly paragraphs: readonly string[];
  // A one-time code, shown large and spaced in its own box (never in the subject or preview).
  readonly code?: string;
  // A button. Only for a link the message already carries; security alerts have none.
  readonly action?: EmailAction;
  // A small grey line under the content ("If you didn't request this, …").
  readonly footnote?: string;
  // Why the recipient gets this email, in the footer. Defaults to DEFAULT_EMAIL_REASON.
  readonly reason?: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface RenderEmailOptions {
  // Absolute URL of the hosted Warthog mark. Omitted (or unsafe), the header is text only.
  readonly logoUrl?: string;
}

export const DEFAULT_EMAIL_REASON = "You're getting this because it's about your Warthog account.";
export const EMAIL_TAGLINE = "Warthog · your personal agent home";
// The small print on every security alert: why there's no button, and what to do instead.
export const SECURITY_ALERT_FOOTNOTE =
  "There are no links in this alert, on purpose. To check your account, open Warthog yourself.";
const GENERIC_SUBJECT = "Warthog";
const GENERIC_HEADING = "An update from Warthog";
const GENERIC_ACTION = "Open Warthog";
const LOGO_PATH = "/icons/icon-192.png";

// The house palette (src/app/globals.css): one near-black accent on neutral greys.
const C = {
  page: "#f3f3f3",
  card: "#ffffff",
  line: "#e7e7e7",
  heading: "#181818",
  text: "#3d3d3d",
  muted: "#6b6b6b",
  soft: "#f3f3f3",
  accent: "#181818",
  accentFg: "#ffffff",
} as const;
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

// The href a URL may have, or null when it must render as plain text: it parses, carries
// no credentials, and is https: — or http: on localhost / 127.0.0.1 for development.
export function linkHref(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.username || parsed.password) return null;
  const local = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !local) return null;
  return parsed.href;
}

// The hosted Warthog mark for the email header, on the configured public origin.
export function emailLogoUrl(publicBaseUrl: string | undefined): string | undefined {
  if (!publicBaseUrl) return undefined;
  try { return linkHref(new URL(LOGO_PATH, publicBaseUrl).href) ?? undefined; } catch { return undefined; }
}

// Apply `fn` (a redaction pass) to every human-readable text field of an email: subject,
// heading, paragraphs, footnote, footer reason and button label. The code and the button's
// URL are left alone: they are not prose, and masking would break them.
export function mapEmailText(content: EmailContent, fn: (text: string) => string): EmailContent {
  return {
    ...content,
    subject: fn(content.subject),
    heading: fn(content.heading),
    paragraphs: content.paragraphs.map(fn),
    ...(content.footnote === undefined ? {} : { footnote: fn(content.footnote) }),
    ...(content.reason === undefined ? {} : { reason: fn(content.reason) }),
    ...(content.action === undefined ? {} : { action: { ...content.action, label: fn(content.action.label) } }),
  };
}

// The content an email sender renders for a message: its own, or the generic layout.
export function emailContentOf(message: OutgoingMessage): EmailContent {
  if (message.email) return message.email;
  return {
    subject: GENERIC_SUBJECT,
    heading: GENERIC_HEADING,
    paragraphs: message.body.split(/\n+/).map((line) => line.trim()).filter(Boolean),
    ...(message.link ? { action: { label: GENERIC_ACTION, url: message.link } } : {}),
  };
}

export function renderMessageEmail(message: OutgoingMessage, options: RenderEmailOptions = {}): RenderedEmail {
  return renderEmail(emailContentOf(message), options);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// The subject is a header: one line, and never a carrier for a code, link or any URL.
function safeSubject(content: EmailContent): string {
  const subject = oneLine(content.subject);
  const leaks = [content.code, content.action?.url].filter((v): v is string => !!v && v.length > 0);
  if (leaks.some((leak) => subject.includes(leak)) || /[a-z][a-z0-9+.-]*:\/\//i.test(subject) || /\bwww\./i.test(subject)) {
    throw new Error("Email subject must not carry a code or link");
  }
  return subject;
}

export function renderEmail(content: EmailContent, options: RenderEmailOptions = {}): RenderedEmail {
  const subject = safeSubject(content);
  return { subject, html: renderHtml(content, subject, options), text: renderText(content) };
}

function renderText(content: EmailContent): string {
  const blocks: string[] = [content.heading, ...content.paragraphs];
  if (content.code) blocks.push(content.code);
  // The same URL the HTML shows: normalised when it is a safe link, verbatim otherwise.
  if (content.action) blocks.push(`${content.action.label}: ${linkHref(content.action.url) ?? content.action.url}`);
  if (content.footnote) blocks.push(content.footnote);
  blocks.push(`${EMAIL_TAGLINE}\n${content.reason ?? DEFAULT_EMAIL_REASON}`);
  return blocks.join("\n\n") + "\n";
}

// Dark mode for the clients that honour it (Apple Mail, iOS, Outlook for Mac): the app's own
// dark tokens. The logo's navy ink sits on a light tile there so it stays legible.
const STYLE = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table { border-collapse: collapse; }
a.wh-button:hover { background-color: #303030 !important; border-color: #303030 !important; }
@media (max-width: 600px) {
  .wh-outer { padding: 20px 12px !important; }
  .wh-card { padding: 28px 22px !important; }
  .wh-footer { padding: 20px 23px 0 !important; }
  .wh-code { font-size: 28px !important; letter-spacing: 6px !important; }
}
@media (prefers-color-scheme: dark) {
  .wh-page { background-color: #181818 !important; }
  .wh-card { background-color: #212121 !important; border-color: #3c3c3c !important; }
  .wh-heading, .wh-wordmark { color: #f3f3f3 !important; }
  .wh-text { color: #dcdcdc !important; }
  .wh-muted { color: #afafaf !important; }
  .wh-rule { border-color: #3c3c3c !important; }
  .wh-code { background-color: #303030 !important; color: #f3f3f3 !important; }
  .wh-button-cell { background-color: #f3f3f3 !important; }
  a.wh-button { background-color: #f3f3f3 !important; border-color: #f3f3f3 !important; color: #0d0d0d !important; }
  .wh-link { color: #afafaf !important; }
  .wh-logo { background-color: #f3f3f3 !important; }
}`;

function renderHtml(content: EmailContent, subject: string, options: RenderEmailOptions): string {
  const preheader = escapeHtml(oneLine(content.paragraphs[0] ?? content.heading));
  const logoSrc = options.logoUrl ? linkHref(options.logoUrl) : null;
  const text = `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};`;

  const logo = logoSrc
    ? `<td class="wh-logo" width="32" style="width:32px;padding:1px;border-radius:8px;vertical-align:middle;">` +
      `<img src="${escapeHtml(logoSrc)}" width="32" height="32" alt="Warthog" style="display:block;width:32px;height:32px;border:0;outline:none;text-decoration:none;"></td>` +
      `<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>`
    : "";
  const header =
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>${logo}` +
    `<td class="wh-wordmark" style="vertical-align:middle;font-family:${FONT};font-size:17px;line-height:24px;font-weight:600;letter-spacing:-0.01em;color:${C.heading};">Warthog</td>` +
    `</tr></table>`;

  const paragraphs = content.paragraphs
    .map((p) => `<p class="wh-text" style="${text}">${escapeHtml(p)}</p>`)
    .join("");

  const code = content.code
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px;"><tr>` +
      `<td class="wh-code" align="center" style="background-color:${C.soft};border-radius:12px;padding:18px 12px 18px 20px;` +
      `font-family:${MONO};font-size:32px;line-height:40px;font-weight:600;letter-spacing:8px;color:${C.heading};">` +
      `${escapeHtml(content.code)}</td></tr></table>`
    : "";

  const action = content.action ? renderAction(content.action, text) : "";

  const footnote = content.footnote
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;"><tr>` +
      `<td class="wh-rule" style="border-top:1px solid ${C.line};padding-top:16px;">` +
      `<p class="wh-muted" style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">${escapeHtml(content.footnote)}</p>` +
      `</td></tr></table>`
    : "";

  const footer =
    `<p class="wh-muted" style="margin:0 0 4px;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">${escapeHtml(EMAIL_TAGLINE)}</p>` +
    `<p class="wh-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};">${escapeHtml(content.reason ?? DEFAULT_EMAIL_REASON)}</p>`;

  return `<!doctype html>
<html lang="en-AU" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>${STYLE}
</style>
</head>
<body class="wh-page" style="margin:0;padding:0;background-color:${C.page};">
<div class="wh-preheader" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};">${preheader}${"&#8203;&nbsp;".repeat(40)}</div>
<table role="presentation" class="wh-page" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};">
<tr><td class="wh-outer" align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;border-collapse:separate;">
<tr><td class="wh-card" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:16px;padding:32px 36px;">
${header}
<h1 class="wh-heading" style="margin:28px 0 12px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;color:${C.heading};">${escapeHtml(content.heading)}</h1>
${paragraphs}${code}${action}${footnote}
</td></tr>
<tr><td class="wh-footer" style="padding:20px 37px 0;">
${footer}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

// A bulletproof table button for a safe URL, with the URL repeated as copyable text under
// it. An unsafe URL renders as plain text only — no anchor, no button.
function renderAction(action: EmailAction, textStyle: string): string {
  const href = linkHref(action.url);
  if (!href) {
    return `<p class="wh-text" style="${textStyle}">${escapeHtml(action.label)}: ${escapeHtml(action.url)}</p>`;
  }
  const attr = escapeHtml(href);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px;"><tr>` +
    `<td class="wh-button-cell" align="center" bgcolor="${C.accent}" style="border-radius:10px;background-color:${C.accent};">` +
    `<a class="wh-button" href="${attr}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 22px;` +
    `border:1px solid ${C.accent};border-radius:10px;background-color:${C.accent};font-family:${FONT};font-size:15px;line-height:20px;` +
    `font-weight:600;color:${C.accentFg};text-decoration:none;">${escapeHtml(action.label)}</a>` +
    `</td></tr></table>` +
    `<p class="wh-muted" style="margin:0 0 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};word-break:break-all;">` +
    `Or paste this link into your browser:<br><a class="wh-link" href="${attr}" target="_blank" rel="noopener noreferrer" style="color:${C.muted};text-decoration:underline;">${escapeHtml(href)}</a></p>`;
}
