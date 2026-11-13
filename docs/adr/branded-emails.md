# Branded HTML emails

Decision: 14 November 2026. The founder asked for the emails Warthog sends to look like proper
emails rather than bare strings, while staying short. Every email went out with the subject
"Warthog" and a one-line text body. No new dependency, schema or migration.

## What changed

- One renderer, `src/server/notify/email.ts`. A caller describes what an email says
  (`EmailContent`: subject, heading, one to three short paragraphs, an optional one-time code, an
  optional button, a footnote and the footer's reason). `renderEmail` returns the subject, an
  email-safe HTML body and a plain-text part that carries everything the HTML does, including the
  link URL.
- `OutgoingMessage` gains an optional `email`. SMS and push still use `body`, which every call
  site keeps unchanged, so texts, pushes and the outbox-based tests are unaffected. An email with
  no `email` content renders a generic layout: the subject "Warthog", `body` as the paragraph and
  `link` as an "Open Warthog" button.
- Every call site gives its own subject and heading: codes, security alerts, reset notices,
  household invites and address changes, operator requests, approval fallbacks, the integrity
  alert and the deletion confirmation. Resend sends `subject`, `html` and `text`. ACS isn't wired,
  but it is updated to match.
- `/dev/outbox` shows each email's subject and a "Preview email" of the real HTML in an iframe
  with every sandbox restriction (`sandbox=""`, `srcdoc`).

## Design

- The house look: a white card on a light neutral background, the hosted Warthog mark
  (`/icons/icon-192.png` on the public origin, alt "Warthog") beside the wordmark, a system font
  stack, near-black buttons (`#181818`) and grey small print.
- The layout is tables with inline styles and is about 560px wide, with no web fonts, external CSS
  or tracking pixel. A hidden preheader repeats the first paragraph.
- Codes sit in their own soft box in large spaced monospace.
- A modest `prefers-color-scheme: dark` block covers the clients that honour it (Apple Mail,
  iOS, Outlook for Mac), with the mark on a light tile. Gmail and Outlook.com apply their own
  inversion.

## Rules

- Every interpolated string is HTML-escaped. A link becomes clickable only when it parses, has
  no credentials, and is `https:` (or `http:` on localhost for development). Any other link is
  shown as text.
- A subject is one line and never carries a code, a link or any URL. The renderer throws rather
  than send one.
- Security alerts still contain no links, on purpose. They end with "There are no links in this
  alert, on purpose. To check your account, open Warthog yourself."
- Untrusted text (agent names, device labels) goes through the redaction pass in every field. It
  is redacted before it is shortened, so a cut can't split a card number past recognition.
- An email with a button also prints the URL under it ("Or paste this link into your browser").
