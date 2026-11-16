# Approval-card truth: approvals show what is going out

Decision date: 16 November 2026. This is the second PR of the read-side protection series
([read-side protection](read-side-protection.md)).

## The problem

- **The card was blind.** An approval card read "Claude wants to use “Send” in Gmail", with To,
  the agent's reason and the default rule. The person approved without seeing the subject or the
  text.
- **Sending needed a hand-built email.** Agents had to pass a base64 RFC 2822 message (`raw`).
  claude.ai can't build that reliably, and recipients were read from it with a regex that
  missed `To :` headers.
- **Invitations had no recipients.** A calendar invitation with guests emails those guests, but it
  had no recipients, so nothing showed who would be invited.

The founder's condition for the series applies: no new approvals, settings or setup, and every
card readable at a glance.

## Decision

### Warthog builds the email (`src/domain/content/compose-mail.ts`)

Gmail and Outlook `draft`/`send` take plain fields:
`{to[], cc[]?, bcc[]?, subject?, text, reply?: {id}, reason}`.
- A hand-built `body` is refused with "Use to, subject and text: Warthog builds the email."
- An `html` version is refused too. Warthog sends exactly the plain text the card shows, so no
  second version can say something else, hide text or carry a tracking image.
- **Recipients come from the fields**, so rules and checks see the real list. An address Warthog
  can't read is refused. A send needs at least one recipient.
- **The message is built from the same input the card shows:**
  - Plain text, UTF-8, with RFC 2047 headers (also for any value that already looks like an
    encoded word). Headers are folded to about 76 columns.
  - Invisible and direction-changing characters are removed from the text, for both
    services.
  - Line breaks are refused in any header, and there is no `from` field.
  - Quoted display names (`"Lee, Sam" <sam@…>`) are accepted, and the address's case is kept.
- **A reply** looks up only the original's headers (Message-ID, References, Subject, thread). It is
  sent in that thread with "Re: …" when it has no subject of its own.
- **Outlook** gets Graph's own message shape. A reply is made with `createReply`, so it is
  threaded, then PATCHed to exactly the approved recipients, subject and text and checked.
  - Graph's reply actions add the original sender or its Reply-To on their own. If the result
    differs from the approved recipients, the draft is deleted and nothing is sent.
  - A send then posts the draft.
- **Recipients are listed explicitly.** The agent lists a reply's recipients itself (usually from
  the checked view's `replyTo` or `from`), so the full list is known before any rule runs.

### The card (`src/domain/approvals/outgoing.ts`, inbox view)

The pipeline stores an `outgoing` summary on the encrypted approval detail, built from the call's
own input:
- **Email:** subject, about 280 characters of opening words, the number of characters or elements
  the recipient won't see, and the domains it links to.
- **Invitation:** title, start and guests.
- **General request:** method, path and query keys.
- **Provider tool:** argument keys and short previews.

Up front, at most three lines:
- **The sentence** names who it goes to or what it is: "Claude wants to send an email to
  sam@example.com", "Claude wants to reply to …", "Claude wants to add “Site visit” to your
  calendar".
- **An email's subject and opening words** sit in a quiet block, or the invitation's guests in its
  place.
- **"Claude says “…”"** with the time left. The reason reads as the agent's own words (a brief copy
  rule).

A rule the person wrote stays up front. Everything else goes behind a native "Details"
disclosure: which account, everyone it goes to, the link domains, "Why you're asked" (the default
ask-first reason), and the conversation and app it came from.

**At most one heads-up** (an info `Notice`, never red), only when something is unusual: "You
haven't emailed X before."

Details also carries the whole message (up to 5,000 characters), To, Copy and Blind copy listed
separately, and every first-time address.

**The first-time check:**
- **What runs:** a search of the person's own Sent mail (Gmail `in:sent {to: cc: bcc:}`, Outlook
  Sent Items), at hold time only.
- **Limits:** at most 5 recipients, run in parallel. It runs outside the approval's transaction
  with a 3-second budget, so the notification is never held up.
- **What goes into the search:** only plain addresses. Anything else, and any past the fifth, is
  reported as "couldn't check", never as new.
- **Exact matches only:** Gmail and Graph search match words, so each hit's To, Cc and Bcc are
  compared with the exact address. A lookalike (john@acme.co for john@acme.co.uk) never counts
  as "emailed before".
- **On failure:** the card says in Details that it couldn't check.
- **What is kept:** only the answer, inside the encrypted approval.

### Invitations

- Calendar create and update read guests from `attendees` as the call's recipients, so the card
  names them and a recipient condition on a broad rule (for example "ask me before any change to
  anyone at rival.example") applies.
- They have no message channel, so an existing "send email" rule doesn't start catching
  invitations.

## Consequences

- **Existing rules now see invitation guests.** A recipient condition on an `any_change`,
  `service_tool` or `specific_tool` rule, ask-first or never-allow, now matches calendar
  invitations with those guests. That is intended, and it goes in the release notes.
- **Held sends from before this change fail when approved.** Gmail and Outlook sends still held
  at deploy carry the old `body`, so they fail on approval with a plain error. Approvals expire
  within 24 hours.

- **The old form is gone.** Agents that sent `raw` messages get a clear refusal and the new
  fields, which their tool list now describes.
- **Ask-first users see no new approvals.** Existing cards get shorter up front.
- **The privacy page** says that Warthog checks results and searches the person's Sent mail for
  the first-time line.
