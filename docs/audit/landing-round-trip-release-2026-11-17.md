# Landing diagrams, round trips — 17 November 2026

Application source `75b433a2b6e2bb0caa46a8fdba46c9e28c8ea6f2` is live as revision
`warthog--r43972166974a1`. It carries PR #37, which changes only the website's "why one home"
diagrams. The founder asked for this: "its not just agents -> warthog -> service but agents ->
warthog -> services -> warthog -> agents ... I want to see packets go back toward the agents". They
also asked for the Without picture to be easier to follow, with fewer packets moving at once. They
wanted it live on [warthog.com.au](https://warthog.com.au).

## What shipped

- **Round trips.** Every line in both connect-once pictures carries a request out, in the
  picture's colour, and its answer back, in the text colour.
  ([design](../design/public-front-door.md), "Diagrams")
- **With Warthog.** One request starts every 2.4s beat, in a 12s cycle.
  - It goes agent → Warthog (the ring marks the check) → service → Warthog → the same agent.
  - Each answer passes back through the hub as the next request arrives, so one ring marks both.
    Two pulses are in flight at most.
- **Without Warthog.** Before, 25 pulses ran at once. Now the 25 lines take turns.
  - One trip starts every 1.2s, so two or three are in flight.
  - Each trip's line lights while it runs.
  - Every line gets exactly one turn per 30s cycle.
- **Pulse size.** Pulses are a fixed 10-unit dash, parked past each line's own length
  (`--wh-pulse-end`). Before, they were 9% of each line, which made them tiny on short lines and
  long streaks on long ones.
- **Captions.** Both captions now say the answer comes back.
- **Unchanged.** The still picture, motion gating (pause, reduced motion, forced colours, out of
  view) and counts.
- **Scope.** No migrations (still 85). No configuration, infrastructure, package, workflow or
  delivery-script changes.

## Verification

- **Pull request:** #37 was rebased onto main `014f91c`. Run
  [43969984881](https://github.com/Orlev01/warthog/actions/runs/43969984881) passed every check
  for tree `72e33cd`, which is the merge commit `75b433a`'s tree.
  - It was merged with a merge commit.
  - The main push and the image build both reused that result.
- **Local checks:**
  - typecheck is clean;
  - the landing and website tests passed, 208/208. New tests check:
    - a request then an answer on every line;
    - that Warthog calls one service and hears back before it answers the agent;
    - that each tangle line takes its own turn.
  - On the dev server, I checked by eye on desktop in light and dark, and at 375px in light.
- **Image:** run [43971587549](https://github.com/Orlev01/warthog/actions/runs/43971587549)
  published `…@sha256:d1ddc5e0…`.
  - It carries the exact source label, journal label `v1`, linux/amd64, UID 1000 and no
    setuid/setgid.
  - All 85 migrations, 106 catalogue entries and 80 brands match by hash.
  - The Node base is unchanged: `e9f565d3…`.
- **Image scan:** 226 OS advisory pairs and none outside OS packages, identical to the previous
  image, with none added or removed.
- **Production:**
  - Run [43972166974](https://github.com/Orlev01/warthog/actions/runs/43972166974) succeeded. Its
    release job ran 22:44–22:48Z on 16 November.
  - Expected configuration hash: `9a8bccaa…`, the same as after the
    [email-safety release](email-safety-release-2026-11-17.md).
  - Independent inspection found one healthy replica on the exact image, explicit 100% traffic,
    zero old replicas, and configuration unchanged apart from image and revision.
- **Production probe:** 62/62.
  - `https://warthog.com.au/` serves 35 lines, 35 request pulses, 35 answer pulses and the new
    captions.
  - The page starts with motion off, and its CSS carries the new keyframes.
  - A real headless browser on the live site saw the motion turn on, and the frames show answers
    heading back to the agents.
- **Runner:**
  - A fresh private lease (11 reviewed creates) was destroyed after the job.
  - The cleanup check found no group, resources, grants, subnet NAT or GitHub runner left.
  - The runner release was 2.338.2, the latest; its checksum was checked against GitHub's release
    notes.

## Coordination

- Session skynet-group-03 wrote #37 and was the release operator.
- It held #37 until session warthog-email-agent-safety had released `102d77f` and pushed that
  release's record (`014f91c`). That session then handed main and this release over.
- Evidence: `warthog-release-evidence/2026-11-17-landing-round-trip-75b433a`.
