# Public front door

The signed-out `/` introduces Warthog before account creation. It shares the
admin console's neutral tokens, licensed local Inter, Lucide icons and pill
actions, with a larger editorial hierarchy appropriate to a public product page.
It does not change the signed-in workspace's dimensions or navigation.

## Entry behaviour

When the app lives at `app.<domain>`, the front door has its own host, `<domain>`
([website-root-domain](../adr/website-root-domain.md)). There `/` always shows the
front door, signed in or not, and never opens the database; Help, compatibility,
privacy and terms are served on both hosts; every other path forwards to the app,
and `www.` forwards to the website. On the app host, `/` sends a signed-out visitor
to sign-in. Without a separate host, `/` shows the front door as described here.

Both `/` (on the app host) and `/signin` verify an existing browser session on the server before
redirecting to Home. Sign-in preserves a validated local return path, including
agent-connection and approval links. Cookie presence alone never proves identity.
Missing, invalid, expired and revoked sessions leave these pages public; an
anonymous request without a cookie does not open the database.

Use the existing session expiry and revocation implementation. Do not lengthen
session lifetimes or weaken cookies to improve this experience. Signup, device
enrolment and recovery have their own state transitions; do not add blanket
redirects to those flows.

## Composition and content

- `Landing` owns a single 1280px outer canvas, with 16px phone gutters and 32px
  wider-screen gutters, leaving at most 1216px of content. `.wh-landing-*` styles
  are scoped so marketing typography cannot alter the app.
- The hero pairs a concise product promise and real signup action with a static
  workspace illustration. The illustration must say it is an example and must
  not present fake buttons, customer data, live metrics or endorsements.
- Follow with compatibility, why one home, the services you can connect, agent controls,
  spending, owned resources, life admin, setup steps, native FAQ disclosures and a closing
  action. Every section is a bounded band,
  panel or card on a tinted page canvas; no copy sits loose on the background
  ([contained text](../adr/contained-text.md)). Inside a section, prefer aligned
  rows and dividers to a border around every paragraph.
- The questions have two groups: Using Warthog, and Security and privacy. The second was
  added on 23 November 2026 after a prospective user said they didn't know "where the data
  gets stored and what the permissions are … how am I protected?". It answers storage,
  protection, agent permissions, staff access, selling and AI training, sign-in, the
  activity record, households, export and deletion, and contact in plain words, and links
  the privacy policy. The staff answer is the founder's wording and doesn't mention the
  admin portal. "We never sell any of your information" is the founder's commitment and
  is stated in the privacy policy (`#never-sold`). Every answer must hold for the code and
  the policy. Never claim end-to-end or zero-knowledge encryption, a certification or
  independent audit, that all data stays in Australia, that staff can never reach
  anything beyond the device-encrypted tier, a tamper-proof record, or deletion of
  everything in a set time.
- The features shipped after launch each have their own section or card, added on
  23 November 2026 because the founder wanted the front door to "reflect the set of
  features", in the page's existing patterns:
  - **Services** (a band like compatibility): "more than 100" (the catalogue holds 107,
    one of them switched off), named as plain text. It says Google is in early access and
    that a missing service can be asked for.
  - **Controls** gain a row for what agents read (marked as written by someone else,
    sign-in codes and reset links held back, a flag on the first email to a new address),
    and the activity row mentions conversations and Undo.
  - **Spending** (its own section of cards): a card released for one purchase with the
    security code never kept, budgets checked before the person is asked, and a household
    budget. The scope note says the limits cover card requests through Warthog only.
  - **Your context** has four cards in pairs: memory and skills, the vault, tasks handed
    between agents, and export.
  - **Life admin** (its own section, in the controls layout with a static example of the
    Records list): filled in by the person's own agent from email, active first with
    reminders, and a log any agent can continue. The scope note says Warthog doesn't read
    email itself. The example uses made-up items, says "Example", and has no controls or
    links. The moving checklist was removed at the founder's request (23 Nov 2026), so the
    page never promises one.
  - **A phone question** in Using Warthog: install from the browser, notifications, and an
    email if one isn't opened. Text-message fallback is switched off in production, so the
    page never mentions it.
- Compatibility varies by platform and plan; link the actual guide. Permissions,
  spending rules and activity records apply to requests through Warthog. Never
  imply control of other providers' direct tools, billing or private memory.
- Keep headlines readable as columns collapse. Navigation, signup, signin and
  disclosures have at least 44px targets. Preserve the skip link, native keyboard
  behaviour, visible focus, semantic headings and useful text beside icons.
- Keep the public header bar sticky on wider screens; on phones and short
  landscape screens the section links scroll away so the bar stays compact. Native
  fragment links scroll smoothly when reduced motion is not requested. Allow
  clearance for the header and safe area so section headings remain visible.
- Use local assets and semantic colour variables, including both system themes.
  Avoid remote fonts, decorative dependencies, autoplay media or tracking added
  as part of visual polish.

## Marketing motion

The founder requested a more animated public page after reviewing React Bits.
Use its [Threads](https://reactbits.dev/backgrounds/threads),
[Dot Grid](https://reactbits.dev/backgrounds/dot-grid) and
[Animated Content](https://reactbits.dev/animations/animated-content) as visual
references. Warthog's flowing SVG artwork and progressive entrance effects are
original implementations using browser APIs; no library code or dependency is
copied into the application.

- Keep animated decoration inside the hero and closing section; the explanatory
  diagrams below are the one other place that moves. Use the existing
  neutral tokens, preserve reading contrast and keep illustrative product data
  still. Do not imply that sample activity is live.
- Gentle entrances may introduce sections once. All content is visible in the
  server response, without JavaScript or when animation support is unavailable.
  Never make access to content depend on an animation completing.
- Provide a named pause/play control with a 44px target. Remember that choice for
  the browser tab. Reduced-motion and forced-colour preferences take precedence;
  pause offscreen backgrounds and hidden tabs, and clean up listeners/animations.
- Fine pointers may gently steer decoration; touch scrolling and links remain
  native. No custom cursor, audio, flashing, full-page parallax or scroll capture.
- Scope motion to the signed-out landing page. Account-entry screens and the
  signed-in workspace retain their existing presentation and behavior.

## Diagrams

Added on 14 November 2026 at the founder's request: "diagrams are a good way to
illustrate the point and purpose of how the tool works and what it offers … don't
overdo it". Three stories from the brief earn a picture, each inside the section it
explains (`landing-diagrams.tsx`):

- **Why one home** (its own section after compatibility): two side-by-side pictures
  of the same five agents and five services. Without Warthog, 25 crossing lines.
  With Warthog, 10 lines through one hub. The drawings carry exactly the counts their
  labels claim. Every request is a round trip (founder, 17 November 2026: "its not
  just agents -> warthog -> service but agents -> warthog -> services -> warthog ->
  agents"): a request pulse in the picture's colour goes out, and its answer comes
  back in the text colour. With Warthog, one request starts per beat; its answer
  passes back through the hub as the next request arrives, so the ring marks both and
  only two pulses are in flight. Without Warthog, each line takes its own turn, two or
  three at once, and lights while its trip runs, so a pulse can be followed through
  the tangle.
- **Ask me first** (in agent controls): the brief's primary journey as five ordered
  steps. Claude asks; Warthog checks the rule; the phone buzzes and the person
  approves; Warthog adds the event; it is on the record.
- **Shared memory** (in owned resources): a memory Claude saves, which ChatGPT uses
  later, with the note that an agent not allowed to read shared memory never sees it.

Rules:

- Every diagram is a figure labelled as an illustration with example agents,
  services and requests. Names appear as text, never as logos, and there are no
  buttons, links or live data inside.
- The still picture tells the whole story in the server markup, so motion is never
  needed to understand it. Lines and step cards are drawn statically. Pulses travel
  the wires, the hub rings as it checks a request, the phone buzzes, and a step
  lights as the pulse arrives. All of that runs only while `LandingMotion` reports
  motion on, the tab visible and the figure in view (`data-motion-surface`). The
  pause control, reduced motion and forced colours leave the still picture.
- Colour: `--wh-tint` marks the path through Warthog and `--wh-danger` marks the
  tangle it replaces. Text stays neutral; nothing is under 12px at 320px wide.
- Claims stay within the front door's limits. Controls apply to requests made
  through Warthog, and memory reaches only the agents allowed to read it.

## Account entry

Sign-in and signup use `AuthScreen`: the same bounded public canvas, a focused
form, a restrained desktop introduction and a visible **Back to home** link on
every step. The form is a bounded panel at every width; phones show it first,
without the desktop introduction, which is its own panel on wider screens. Help,
compatibility, privacy and terms share the `PublicPage` frame: header and footer
bars outside `<main>` and content in panels.
The brand and home link lead to the front door (the website's root when it has its
own host, else `/`); account-method links retain the validated return destination.
On the website host, every sign-in, sign-up, recover and reset link is an absolute
link to the app. Returning to the homepage never submits a form.

Signup shows four stages: details, email verification, sign-in method and saving
the recovery code. Passkey and authenticator setup are alternatives within the
same stage. Keep recovery warnings and confirmation visible. Group alternate
sign-in/recovery routes under a native disclosure, while account creation remains
visible. Code-entry errors stay associated with their field; passkey cancellation
and delivery failures describe the form without declaring the email invalid.
Preserve the existing pending guards, required factors and session checks.

## Verification

Use the real request context for public page tests and real session rows for
redirect checks. Render tests complement browser checks; they do not prove layout
or keyboard accessibility. Check 320–1920px, tablet and short landscape, both
themes, safe-area insets, reduced motion, FAQ disclosure and the actual account
entry links. Use synthetic examples for screenshots.
