// Branded email rendering (`./email`): one structured model, one renderer, and the generic
// layout every unmigrated sender falls back to. These tests pin the security rules a
// reviewer vetoes on: every interpolated string is escaped, only a safe URL becomes an
// href, the subject never carries a code or link, and the text part carries everything the
// HTML does.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EMAIL_REASON,
  emailContentOf,
  emailLogoUrl,
  linkHref,
  renderEmail,
  renderMessageEmail,
  type EmailContent,
} from "./email";

const HOSTILE = `<script>alert("x")</script><img src=x onerror=alert(1)> & 'quoted' "agent"`;

const CODE_EMAIL: EmailContent = {
  subject: "Your Warthog verification code",
  heading: "Your verification code",
  paragraphs: ["Enter this code in Warthog to continue. It expires in 10 minutes."],
  code: "042917",
  footnote: "If you didn't request this, you can ignore this email.",
};

// Every href value in the markup, unescaped only for &amp; (the one entity a URL carries).
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
}

test("the subject is the content's own subject, and the heading and paragraphs are in both parts", () => {
  const rendered = renderEmail({
    subject: "New passkey added",
    heading: "A new passkey was added",
    paragraphs: ["A new passkey was added to your Warthog account.", "If this wasn't you, sign in and remove it."],
    footnote: "This alert has no links on purpose.",
  });
  assert.equal(rendered.subject, "New passkey added");
  assert.match(rendered.html, /<title>New passkey added<\/title>/);
  assert.ok(rendered.html.includes("A new passkey was added</h1>"), "the heading is the H1");
  assert.ok(rendered.html.includes("If this wasn&#39;t you, sign in and remove it."));
  for (const piece of ["A new passkey was added", "A new passkey was added to your Warthog account.",
    "If this wasn't you, sign in and remove it.", "This alert has no links on purpose.", DEFAULT_EMAIL_REASON]) {
    assert.ok(rendered.text.includes(piece), `the text part carries "${piece}"`);
  }
});

test("a hostile agent name is HTML-escaped everywhere it lands", () => {
  const rendered = renderEmail({
    subject: `New agent ${HOSTILE}`,
    heading: `Agent ${HOSTILE}`,
    paragraphs: [`"${HOSTILE}" connected to your Warthog account.`],
    footnote: HOSTILE,
    reason: HOSTILE,
  });
  assert.doesNotMatch(rendered.html, /<script/i, "no script element survives");
  assert.doesNotMatch(rendered.html, /<img src=x/i, "no injected element survives");
  assert.doesNotMatch(rendered.html, /<[^>]*\sonerror=/i, "no injected attribute lands inside a tag");
  assert.ok(rendered.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"), "markup characters are escaped");
  assert.ok(rendered.html.includes("&amp; &#39;quoted&#39; &quot;agent&quot;"), "& ' and \" are escaped");
  // The text part is plain text: the name appears verbatim there, never interpreted.
  assert.ok(rendered.text.includes(HOSTILE));
});

test("no rendered email carries a script element, an external stylesheet or a tracking pixel", () => {
  const rendered = renderEmail({ ...CODE_EMAIL, action: { label: "Open Warthog", url: "https://warthog.com.au/home" } },
    { logoUrl: "https://warthog.com.au/icons/icon-192.png" });
  assert.doesNotMatch(rendered.html, /<script/i);
  assert.doesNotMatch(rendered.html, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(rendered.html, /@import/i);
  const images = [...rendered.html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(images.length, 1, "the logo is the only image");
  assert.match(images[0]!, /src="https:\/\/warthog\.com\.au\/icons\/icon-192\.png"/);
  assert.match(images[0]!, /alt="Warthog"/);
});

test("the code renders large in the HTML and on its own line in the text part, never in the subject", () => {
  const rendered = renderEmail(CODE_EMAIL);
  assert.ok(!rendered.subject.includes(CODE_EMAIL.code!), "the subject never carries the code");
  assert.match(rendered.html, /<td[^>]*class="wh-code"[^>]*>042917<\/td>/, "the code has its own box");
  assert.match(rendered.html, /font-family:[^;"]*monospace/, "in a monospace face");
  assert.match(rendered.html, /letter-spacing:\s*\d+px/, "spaced out");
  assert.match(rendered.text, /^042917$/m, "the text part carries the code on its own line");
  assert.match(rendered.text, /\b\d{6}\b/, "the six-digit code is still extractable from the text part");
});

test("the preheader previews the first paragraph and never the code", () => {
  const rendered = renderEmail(CODE_EMAIL);
  const preheader = rendered.html.match(/<div class="wh-preheader"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.ok(preheader.startsWith("Enter this code in Warthog to continue."), "the first paragraph previews");
  assert.ok(!preheader.includes("042917"), "the code never reaches the inbox preview");
  assert.match(rendered.html, /<div class="wh-preheader"[^>]*display:\s*none/, "the preheader is hidden");
});

test("a subject that would carry the code or the link is refused", () => {
  assert.throws(() => renderEmail({ ...CODE_EMAIL, subject: "Your code is 042917" }), /subject/);
  assert.throws(() => renderEmail({ subject: "Open https://warthog.com.au/a/token", heading: "x", paragraphs: [],
    action: { label: "Open", url: "https://warthog.com.au/a/token" } }), /subject/);
  assert.throws(() => renderEmail({ subject: "Visit http://example.test now", heading: "x", paragraphs: [] }), /subject/);
});

test("a subject is a single line", () => {
  const rendered = renderEmail({ subject: "New passkey\r\nBcc: leak@example.test", heading: "x", paragraphs: [] });
  assert.equal(rendered.subject, "New passkey Bcc: leak@example.test");
});

test("an https action becomes a button, and its URL is in the text part", () => {
  const url = "https://warthog.com.au/a/approval-token?x=1&y=2";
  const rendered = renderEmail({ subject: "An approval is waiting", heading: "Approval waiting", paragraphs: ["Decide."],
    action: { label: "Open approval", url } });
  assert.ok(hrefs(rendered.html).includes(url), "the safe URL is the button's href");
  assert.match(rendered.html, /<a [^>]*class="wh-button"[^>]*>Open approval<\/a>/);
  assert.ok(rendered.html.includes("x=1&amp;y=2"), "the URL is attribute-escaped");
  assert.ok(rendered.text.includes(`Open approval: ${url}`), "the text part carries the label and URL");
});

test("javascript:, data:, plain http and malformed links are never made clickable", () => {
  for (const url of ["javascript:alert(document.cookie)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>",
    "http://evil.example/steal", "http://localhost.evil.example/", "//evil.example/x", "not a url", "https://user:pw@warthog.com.au/"]) {
    const rendered = renderEmail({ subject: "Something", heading: "x", paragraphs: ["y"], action: { label: "Open", url } });
    assert.deepEqual(hrefs(rendered.html), [], `${url} must not become an href`);
    assert.doesNotMatch(rendered.html, /class="wh-button"/, `${url} must not render a button`);
    assert.doesNotMatch(rendered.html, /<script/i);
    assert.ok(rendered.text.includes(url), "the text part still carries what was sent, as plain text");
  }
});

test("http links are clickable only for local development hosts", () => {
  assert.equal(linkHref("https://warthog.com.au/a/x"), "https://warthog.com.au/a/x");
  assert.equal(linkHref("http://localhost:3000/a/x"), "http://localhost:3000/a/x");
  assert.equal(linkHref("http://127.0.0.1:3000/a/x"), "http://127.0.0.1:3000/a/x");
  assert.equal(linkHref("http://warthog.com.au/a/x"), null);
  assert.equal(linkHref("ftp://warthog.com.au/a/x"), null);
});

test("the logo URL is built from the public base URL, and a missing or unsafe one omits the image", () => {
  assert.equal(emailLogoUrl("https://warthog.com.au"), "https://warthog.com.au/icons/icon-192.png");
  assert.equal(emailLogoUrl("https://warthog.com.au/"), "https://warthog.com.au/icons/icon-192.png");
  assert.equal(emailLogoUrl("http://localhost:3000"), "http://localhost:3000/icons/icon-192.png");
  assert.equal(emailLogoUrl(undefined), undefined);
  assert.equal(emailLogoUrl("javascript:alert(1)"), undefined);
  const withoutLogo = renderEmail(CODE_EMAIL);
  assert.doesNotMatch(withoutLogo.html, /<img/i, "no logo URL, no image");
  assert.ok(withoutLogo.html.includes(">Warthog<"), "the text wordmark still reads");
  const unsafeLogo = renderEmail(CODE_EMAIL, { logoUrl: "javascript:alert(1)" });
  assert.doesNotMatch(unsafeLogo.html, /<img/i, "an unsafe logo URL is dropped");
});

test("the layout declares light and dark colour schemes and stays within the email-safe width", () => {
  const { html } = renderEmail(CODE_EMAIL);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /max-width:\s*560px/);
  assert.match(html, /role="presentation"/);
  assert.ok(html.includes("Warthog · your personal agent home"));
  assert.ok(html.includes("You&#39;re getting this because it&#39;s about your Warthog account."));
});

test("an unmigrated message renders the generic layout: subject Warthog, body as the paragraph, link as the button", () => {
  const message = { recipient: "person@example.test", body: "Something happened.\nSecond line.", link: "https://warthog.com.au/a/x" };
  const content = emailContentOf(message);
  assert.equal(content.subject, "Warthog");
  assert.deepEqual(content.paragraphs, ["Something happened.", "Second line."]);
  assert.deepEqual(content.action, { label: "Open Warthog", url: "https://warthog.com.au/a/x" });
  const rendered = renderMessageEmail(message);
  assert.equal(rendered.subject, "Warthog");
  assert.ok(hrefs(rendered.html).includes("https://warthog.com.au/a/x"));
  assert.ok(rendered.text.includes("Something happened."));
  assert.ok(rendered.text.includes("https://warthog.com.au/a/x"));
});

test("a migrated message renders its own email content, not the generic layout", () => {
  const rendered = renderMessageEmail({ recipient: "person@example.test", body: "plain body", email: CODE_EMAIL });
  assert.equal(rendered.subject, "Your Warthog verification code");
  assert.ok(rendered.text.includes("042917"));
  assert.ok(!rendered.text.includes("plain body"), "the plain body is the SMS/push/outbox copy, not the email");
});
