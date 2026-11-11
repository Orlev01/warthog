# Public front door

The signed-out `/` introduces Warthog before account creation. It shares the
admin console's neutral tokens, licensed local Inter, Lucide icons and pill
actions, with a larger editorial hierarchy appropriate to a public product page.
It does not change the signed-in workspace's dimensions or navigation.

## Entry behaviour

Both `/` and `/signin` verify an existing browser session on the server before
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
- Follow with compatibility, agent controls, owned resources, setup steps,
  native FAQ disclosures and a closing action. Prefer aligned rows and open
  columns to a border around every paragraph.
- Compatibility varies by platform and plan; link the actual guide. Permissions,
  spending rules and activity records apply to requests through Warthog. Never
  imply control of other providers' direct tools, billing or private memory.
- Keep headlines readable as columns collapse. Navigation, signup, signin and
  disclosures have at least 44px targets. Preserve the skip link, native keyboard
  behaviour, visible focus, semantic headings and useful text beside icons.
- Use local assets and semantic colour variables, including both system themes.
  Avoid remote fonts, decorative dependencies, autoplay or tracking added as
  part of visual polish.

## Verification

Use the real request context for public page tests and real session rows for
redirect checks. Render tests complement browser checks; they do not prove layout
or keyboard accessibility. Check 320–1920px, tablet and short landscape, both
themes, safe-area insets, reduced motion, FAQ disclosure and the actual account
entry links. Use synthetic examples for screenshots.
