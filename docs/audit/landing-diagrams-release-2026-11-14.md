# Landing diagrams release — 14 November 2026

Application source `7eb72f683057464726568329f632132030592385` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision `warthog--r43555128449a1`. The
founder asked for diagrams on the public site that show what Warthog solves and how it works,
"all the way to production publishing". Main had moved on since the last release, so this
plain `update` carries three changes:

1. **PR #25, landing diagrams (main `7eb72f6`):** three animated, explanatory diagrams on the
   signed-out front door, each in the section it explains
   ([design](../design/public-front-door.md), "Diagrams").
   - **Why one home** (a new section): five agents and five services. Without Warthog there are
     25 crossing lines; with Warthog there are 10 lines through one hub.
   - **Ask me first:** the brief's primary journey in five ordered steps.
   - **Shared memory:** a memory Claude saves that ChatGPT uses later.

   Data pulses, the hub's ring, the phone's buzz and the step highlights run only while the
   landing's motion system is on and the figure is in view. Pausing, reduced motion and forced
   colours leave the still picture.
2. **PR #24, sign-in race and branded emails (main `c4f9cb7`), by session d3 and merged by the
   founder:** sign-ins and factor changes re-check their proof against an in-flight recovery
   eviction ([ADR](../adr/signin-audit-fixes-2026-11.md) §7), and emails are short, branded
   HTML through Resend ([ADR](../adr/branded-emails.md)).
3. **Dependabot PR #11 (main `77c5d3b`):** lucide-react 1.70.0.

No migrations (still 83) and no configuration, infrastructure, workflow or delivery-script
changes. Both hostname bindings were kept.

## Verification

- **CI:** PR #25 passed on its branch. Main `77c5d3b` passed before the merge. The image run
  [43550818566](https://github.com/Orlev01/warthog/actions/runs/43550818566) repeated the
  suite before publication: **6,077 tests**, zero failures.
- **Local checks:**
  - typecheck and `next build` passed;
  - the new `landing-diagrams.test.tsx` passed, checking that:
    - the drawn line counts match the 25 and 10 labels;
    - the steps are in order;
    - there are no controls and nothing is hidden;
    - each diagram sits in its section.
- **Real browser, dev server:**
  - the section runs 36 animations in view, 0 after Pause and 0 with reduced motion;
  - labels are at least 12.3px at 320px wide;
  - there is no horizontal overflow at 320, 390, 820 or 1280px, and no console errors.
- **Image:** `…@sha256:d927fa4b…` carries:
  - the exact source label, journal label `v1`, linux/amd64, UID 1000, no setuid/setgid;
  - matching hashes for all 83 migrations, 106 catalogue entries and 80 brands.

  Its scan shows 220 OS advisory pairs and none outside OS packages. Against the previous
  image, one pair was added and none removed. The added pair is `dpkg` 1.21.23
  CVE-2026-91094, severity unknown. It is a newly published advisory against the same pinned
  base image, not a package this change brought in.
- **Production:** run [43555128449](https://github.com/Orlev01/warthog/actions/runs/43555128449)
  (expected configuration `e365df0c…`) succeeded. Independent inspection found:
  - one healthy replica running the exact image;
  - explicit 100% traffic and zero old replicas;
  - configuration unchanged apart from image and revision;
  - both custom domains still bound with SNI.
- **Production probe:**
  - `https://app.warthog.com.au/` serves all three diagrams: 35 drawn lines, 35 pulses and
    both flows.
  - The page starts with motion off in the markup.
  - In a real browser, the pictures animate in view (36 animations, 11 in the ask-first flow),
    with none under reduced motion and no overflow or console errors on desktop or phone in
    dark mode.
  - `/admin` and `/handoff` still return 404, and health is ok.
- **Runner:** a fresh private lease (11 reviewed creates) was destroyed after the job. Cleanup
  was verified, and no GitHub runner remains.

## Coordination

Session be was the sole release operator. Session d3 agreed not to merge or dispatch during
the release. Main was frozen from the image build to the release dispatch.
