# Requests for members: Contact us, your requests, and arrivals by email

Date: 20 November 2026. Status: accepted (founder: "Do the optional extras", after PR #40).

## Context

PR #40 moved the two in-app requests ("Request a service" and Google "Early access — ask to join")
from the founder's inbox to the admin portal's Requests page. That left three gaps:

- **No in-app way to write to us.** Support and privacy questions still had to go to
  `oren@nava-co.com` by email, from links in the privacy page, the terms and the Activity
  integrity advice.
- **People couldn't see their own requests.** The brief requires that "the person sees their
  requests with a 'Requested' status", but Connectors showed nothing once a request was sent, and
  every click filed another row.
- **Nobody was told when a request arrived.** The brief requires that the person "is notified when
  a catalogue entry is added" that matches. `notifyMatchingRequests` existed but nothing called it,
  and it sent a push, which carries no text in Warthog (only a fixed destination).

## Decision

### Contact us

`/contact` is a protected page, under Help in the sidebar and in More. It has:
- one form: a topic (A question / Something isn't working / A privacy request / An idea / Something
  else) and a message of up to 2,000 characters;
- the person's address, which is where the reply goes;
- "Your messages", each marked Sent or Answered.

**How a message is stored.** It is a third request kind, `contact` (migration 0116 adds `topic` and
`message`, with a check that only messages carry them). It therefore reaches the admin Requests page
with the same account facts as other requests. The portal shows its text with line breaks, the
Message badge, and a mail link with the subject "Re: your message to Warthog". Only the operator's
Mark done settles a message, and the person then sees it as Answered.

**Cleaning.** Before a message is stored, invisible characters are stripped and sign-in codes and
one-off passwords are masked by the read-guard filters. Card numbers are masked to their last four
digits by the redaction module. The text is cleaned again when the portal shows it. This follows
the hard rule that no code or card number is stored in plain text. The portal holds no data key, so
the text can't be encrypted under the person's own key.

**Limit.** A person can send five messages a day. The next one is turned away with a plain notice.

**The support address stays** on the public pages for anyone who can't sign in, beside a link to
Contact us. Security alert emails keep it too, because whoever receives them may be locked out. The
Activity integrity advice now points to Contact us.

### Your requests

Connectors' catalogue tab ends with "Your requests": the person's own service and early-access
requests, newest first, at most 20. Each request has one of three statuses:
- **Requested** while it waits.
- **Ready to connect** once a catalogue entry this person can connect matches it, with a "Find it"
  link to the catalogue search. For early access the label is **You're in**, once they're on the
  Google list.
- **Reviewed** once the operator has closed it without it arriving.

**Matching.** The matcher is shared (`src/server/connectors/request-match.ts`), so the portal, the
page and the sweep agree. It counts a Google entry only for someone on the list.

**No duplicates.** Asking again for a service the person is already waiting on, or for early access
already asked for, records nothing new. A gated entry that has been asked for shows "Asked to join —
We'll email you when you're in" instead of the button.

### Arrivals by email

A new hourly sweep, `request-arrivals`, runs at the first tick after boot. The catalogue and the
Google list change only with a release, so that is soon enough. Each run:
- finds waiting service requests that a connectable entry now answers for that person, and waiting
  early-access requests whose person is now on the list;
- claims each one by marking it `matched` while it is still `requested`. A rolling deploy's two
  replicas therefore tell the person once.
- sends each person one branded email naming everything that's ready, with an "Open Connectors"
  button.

**Excluded.** Deleted accounts are skipped. Messages are never matched.

**Failures.** A failed send is logged by error class only, never by address. The request stays
claimed, and the page still shows it as ready.

**Why email, not push.** A push carries no text in Warthog, and the person needs to know which
service has arrived. `notifyMatchingRequests` is removed.

## Consequences

- **Privacy page.** It now says messages are kept with the account and seen with the person's
  address, that cards and codes are hidden before a message is kept, and that we email once when a
  requested service arrives. The terms and the help page link to Contact us.
- **First run after release.** The first sweep emails anyone whose earlier request is already
  answered. For example, someone who asked for a service that's since been added gets one email. That
  is the promised notification, arriving late, and each request is told only once.
- **Messages count towards waiting.** They count in the Overview's "N requests are waiting for you".
  Usage's request counts stay service-only.
- **Not built:** replying from inside the portal (the operator replies by email); attachments;
  showing the operator's reply in the app.
