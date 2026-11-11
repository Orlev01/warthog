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
- Keep public navigation sticky, including the section links on phones. Native
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

- Keep animated decoration inside the hero and closing section. Use the existing
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

## Account entry

Sign-in and signup use `AuthScreen`: the same bounded public canvas, a focused
form, a restrained desktop introduction and a visible **Back to home** link on
every step. Phones show the form directly, without the desktop introduction.
The brand and home link lead to `/`; account-method links retain the validated
return destination. Returning to the homepage never submits a form.

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
