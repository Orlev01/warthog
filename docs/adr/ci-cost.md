# CI cost: check each version of the source once

Decision date: 16 November 2026. The repository went private on 14 November, which moves
GitHub Actions to 2-core runners billed against the GitHub Free allowance of 2,000 minutes a
month. The allowance ran out two days later and a release was refused. The founder asked why
CI cost so much, and for the safe fixes.

## What it cost (measured, 16 November 2026)

- **One change used about 300 runner-minutes.** The same full checks ran three times, about
  95 minutes each:
  - on the pull request;
  - again on the push to main, for the same tree;
  - again inside the image build (`azure-image.yml` calls `ci.yml`).
- **The suite ran about twice as long once private.** The four shards summed to 42–59 minutes
  on public 4-core runners and 78–101 minutes on private 2-core runners.
- **Inside a shard, the tests are nearly all of it.** For PR #29's shard 2/4, the tests took
  17.9 of 19.8 minutes. The type check took 3 s, the PostgreSQL checks a few seconds, and the
  verification image build 1.3 minutes.
- **Most test time went on starting databases.** `freshDb()` ran 2,853 times in 286 test
  files, and each started a new PGlite cluster (about 0.5 s) and applied every migration
  (about 0.15 s).
- **Other waste.** An image build on 14 November spent 111 minutes on checks and then failed
  in publish because its approval reference was invalid. Dependabot could open up to 11 update
  PRs a week, each running the full checks.

## Decision

1. **Run the full checks once per version of the source.**
   - **Always in full:** pull requests and manual runs.
   - **May reuse:** a push to main and an image build skip the checks only when the identical
     git tree already passed them on the same pinned Node base.
   - **Why the trees match:** a pull request's tested merge has the same tree as its merge
     commit when main has not moved. PR #29's tested merge `d63e3c8` and main's `7e7a4e6`
     both have tree `df6598a`.
   - **The evidence** is the final job of a full run, `Full checks passed for tree <tree> on
     <base>`. It runs only when every check passed. `scripts/ci/reuse_checks.py` accepts it
     only where these flows leave it, in runs of `ci.yml` or `azure-image.yml` from this
     repository:
     - a push or image-build run on `main`, for this commit;
     - a pull request's run from a branch other than `main`, on the merged pull request's head
       (the merge commit's second parent).
   - **Anything uncertain runs the full checks:** an API error, a base that can't be pinned,
     or no matching job.
   - **Merge commits only.** Squash and rebase merges leave the pull request's head out of the
     commit's parents, so their push runs the full checks.
2. **One pinned Node base per run.** The `plan` job resolves `node:22-bookworm-slim` to its
   digest once, or takes the image build's reviewed digest, and every shard uses it. Before,
   each shard pulled the tag separately. An image build reuses only a result for its own base.
   To get that reuse, dispatch it with the base the pull request's checks passed on.
3. **Test databases are copies.** `freshDb()` applies the migrations once per test process,
   through the real runner over the real adapter (`pgliteDb`, which `createDb("pglite:…")` now
   returns). It dumps that database and opens each test's database from the dump. Each copy is
   still a separate in-memory database.
4. **The image build checks its approval reference first.** Its `gate` job runs the same
   `common.gate()` check that publish runs.
5. **Documentation-only changes run nothing.** That means `docs/**` and the top-level `*.md`
   files. None is in the build context, the image or any test. Markdown anywhere else still runs
   the checks, so a Markdown file the app later reads is checked.
6. **Dependabot runs monthly, grouped.** Minor and patch updates arrive as one PR each for npm,
   GitHub Actions and Docker, and Tailwind's packages as one. Other majors still arrive one per
   PR.

## What stays the same

- **The checks:** clean Node 22 Linux, PostgreSQL 16, the full suite, TypeScript and the
  runtime image.
- **No untested code is released.** A release still requires that the exact source and base it
  publishes passed every check.
- **CI stays read-only.** `plan` needs `actions: read` and `contents: read`, and nothing in CI
  writes.
- **What the evidence proves, and its limit.** An honest workflow only names the tree it checked,
  and the tree includes `ci.yml`, so a matching result ran this commit's own checks.
  - **The limit:** GitHub doesn't record which branch a pull request run targeted. Someone with
    write access could open a pull request from a branch at the merged head into a branch whose
    edited `ci.yml` names a passing job for main's tree. An image build of main would then skip
    its checks.
  - **Not a new power:** main has no branch protection (GitHub Free can't enforce it on a private
    repository), so the same person can already change main's checks directly. Only main's own
    code can be published this way.
  - **If branch protection becomes available,** accept only the push and image-build evidence on
    main. That costs one more full run per change.
- **The PostgreSQL image is a tag** (`postgres:16-bookworm`), so a reused result may come from
  an earlier 16.x patch release than a fresh run would use. That was already true between shards.

## Measured, and to be measured

- **Locally (same machine):**
  - the eight heaviest database test files: 37.5 s before, 10.7 s after, 308 tests passing;
  - the full suite: 477 s before and 301 s after, 6,144 tests passing;
  - the summed test time fell from about 1,763 s to 906 s.
- **Per database:** starting a PGlite cluster takes 480–690 ms and migrating it 130–230 ms.
  Dumping the result (44 MB) takes about 30 ms, and opening a copy 126–135 ms.
- **On CI:** expected to fall from about 95 to roughly 50–60 minutes per full run, and a change
  from about 300 to about 60–65 minutes. The first pull request run measures this.

## Not changed

- **The hourly runner-lease cleanup.** GitHub ran it about 4–5 times a day, roughly 150 minutes
  a month. It is the safety net for a forgotten private runner.
- **Four shards.** Revisit after measuring.
- **The repository's Dependabot security alerts and security updates.** They are off, and
  turning them on is the founder's setting to change. Until then, dependency fixes arrive only
  with the monthly updates.
- **Sharing one migrated copy across test processes.** It would save about 0.7 s per test file,
  but it needs an on-disk cache.

## Rollback

Revert the commit. Nothing is stored except job names in Actions history. Without the reuse
step, every run checks in full again.
