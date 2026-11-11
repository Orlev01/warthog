# Admin console design validation

Reviewed on 11 November 2026 in an isolated worktree starting at `58beb72` and
updated to `f8d88ed` from main (a documentation-only release record). The production
checkout and the other agent's worktrees were not changed.

## Automated checks

The final local run passed all 5,154 tests, TypeScript and the production build,
including the added server-selected-tab and retained-record-panel cases.
All six [main-branch CI checks](https://github.com/Orlev01/warthog/actions/runs/42923528755)
passed on merged source `fc131da`: 5,154 tests across four Linux/PostgreSQL 16
shards, with no failures, cancellations or skips.
The four changed contributor skills pass `quick_validate.py`. No application
package or lockfile changes are required.

## Browser review

Chrome ran against a local development database containing synthetic agents,
memories, a card label and a receipt. Stress fixtures included a long unbroken
agent name, a long URL and a long receipt reference. No reference-workspace
content, credentials or screenshots are included in the repository.

The responsive matrix covered:

- All 14 primary destinations at 320px and 1440px.
- All nine individual-agent sections at 320px and 1024px, checking both selected
  navigation levels and retained agent scope.
- Home, Agents, Skills, Rules, Memory and Spending at 768px, 1023px and 1920px.
- Security, notifications, privacy, agent defaults, cards, agent connection,
  receipts, tasks, catalogue and skill import at 320px.
- Focused interaction checks at 390px and short 844×390 landscape with emulated
  44px left/right and 21px bottom safe areas.

These are 74 route/width inspections plus the focused interactions. Long agent
names exposed overflow in Spending, Rules and Memory; the fixes were verified
at 320px and 1440px. Wide pages cap at 1216px, reading pages at 896px and focused
settings forms at 768px, including gutters. Navigation switches at 1024px.

Verified interactions:

- Mobile drawer opens as a named modal, uses independently scrolling navigation,
  dismisses with Escape, restores focus to its trigger and closes at desktop width.
- Nested agent tabs select the correct resource/control group without changing agents.
- Skills and life-admin drafts survive switching between in-page panels.
- Tab arrows wrap, Home/End select the ends, and Back/Forward restore selection.
- Direct view URLs render their selected panel before hydration. Catalogue search
  preserves its query when switching views and navigating back.
- Disconnect confirmation initially focuses Keep connected and cancels with Escape;
  no agent was disconnected. At 320px the dialog remains 288px wide.
- Error feedback remains visible in the selected view. The Copy toast stays inside
  the 320px viewport; dismissal returns focus to Copy. The copied value is not echoed.
- Light and dark themes, reduced-motion emulation and safe-area layout were inspected.
  Browser warning/error logs were empty during these checks.

The preview was stopped; its temporary dev-only sign-in helper was removed.
Browser overrides and temporary tabs were cleaned up. Actual assistive-technology
announcements, physical-device safe areas and provider connections were not tested.

The [production release](../audit/admin-console-release-2026-11-11.md) subsequently
passed all 16 public acceptance checks and read-only authenticated browser checks
at 1440, 390 and 320px. Live tab selection, mobile drawer Escape/focus return and
overflow checks passed, with no browser warning/error logs. No production records
or account settings were changed by these checks.
