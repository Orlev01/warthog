# UI/UX skills and tools: evaluation and selection

Part of the [member-app UI/UX audit, 23 November 2026](README.md).

## What we needed

Warthog is a Next.js 16 / React 19 / Tailwind 4 app with:
- hand-rolled primitives;
- lucide icons;
- a pinned dependency list, where adding a runtime dependency needs an ADR;
- its own contributor design-system skill (`.agents/skills/warthog-design-system`).

The 12 November pass had already cleared most mechanical defects, so the tools had to help with four things:
1. **Critique structure and usability** of an existing app: information architecture, cognitive load and journeys. This is the main gap.
2. **Produce checkable evidence** for accessibility (WCAG 2.2 AA) and code-level interface rules.
3. **Stress-test layouts** with realistic and worst-case data.
4. **Later, help implement refinements** *inside* the existing design system, without replacing it.

What disqualified a tool:
- It replaces the visual language (palette, fonts, "anti-AI-slop" mandates).
- It adds runtime npm dependencies.
- It installs hooks or global configuration.
- It runs unpinned remote code.

## Method

For each candidate, the README **and** the actual skill files (SKILL.md, references, scripts) were read through `gh api`. Star counts and dates are from the GitHub API on 23 November 2026. Nothing was installed until the selection below was made.

## Candidates

### nextlevelbuilder/ui-ux-pro-max-skill (153k stars, v2.15.0, active)

**What it contains.** A plugin that installs **seven** broadly-triggering skills: `ui-ux-pro-max`, `design`, `ui-styling`, `design-system`, `brand`, `slides` and `banner-design`.
- The core is a BM25 keyword search (Python) over CSV files: 141 UX guidelines, 194 palettes, 74 font pairings and 22 stacks.
- `--design-system` generates a new design system from an industry lookup.
- Sibling skills call Gemini and other image APIs, and run `npx shadcn add`.

**Fit.** Poor. It looks rules up but never inspects your UI. It prescribes palettes and fonts, and pushes shadcn. Seven auto-triggering skills would compete with our own design-system skill. Its quick-reference checklist is reasonable, but it duplicates Vercel's.

**Verdict:** not used.

### pbakaus/impeccable (115k stars, v4.10.0, active)

**What it contains.** One skill with 24 commands:
- Evaluate: `critique`, `audit`.
- Refine: `polish`, `distill`, `clarify`, `layout`, `harden`, `onboard`, …
- Build: `shape`, `init`, `document`, `extract`, `live`, …

It also ships a native detector binary and optional hooks.

**Methodology.** The strongest critique method found.
- `reference/critique.md` requires two isolated assessments: a design review, and detector plus browser evidence.
- It scores Nielsen's 10 heuristics 0–4, and runs an eight-item cognitive-load checklist and persona walkthroughs (`critique-rubric.md`).
- Findings are ranked P0–P3.
- `audit.md` scores accessibility, performance, theming, responsiveness and implementation integrity against concrete criteria.
- Its "Operate" mode (app UI) and "Refinement preserves; redesign replaces" both fit an existing product.

**Risks.**
- The launcher downloads a native binary (checksummed) on first run.
- `npx impeccable install` adds SessionStart, PostToolUse and Stop hooks.
- The `live` mode can spawn agents with permission bypass.
- Some telemetry.
- `craft-floor.md` bans some patterns Warthog uses deliberately: eyebrow labels, Inter and one-sided borders.

**Verdict: selected**, hardened:
- the skill folder only;
- pinned at `b49177d`;
- no hooks;
- never `live`;
- no `document` or `extract`;
- `DO_NOT_TRACK=1`.

Our design system wins over its style bans ("the brief wins").

### Leonxlnx/taste-skill (120k stars, v2.5.1)

**What it contains.** A marketing-site generator that:
- picks palettes and Google Fonts at random ("deal, never choose by taste");
- adds shader scenes;
- fetches photos and icons from the network;
- registers a Stop hook.

It has no path for auditing app UI.

**Verdict:** not used.

### anthropics/skills (199k stars)

**What it contains.**
- `frontend-design`: instructions for creating a distinctive *new* visual identity; good prose on avoiding generic UI.
- `webapp-testing`: Python Playwright with a server helper.
- `web-artifacts-builder`: claude.ai artifacts with React 18 and shadcn.
- `brand-guidelines` and `theme-factory`: Anthropic's own brand and themes.

**Fit.**
- `frontend-design` aims at new work, not refinement inside an established system.
- Its section on writing in design (one name per action, errors, empty states) is worth folding into our design-system skill.
- `webapp-testing` adds nothing over the Playwright install we already use.

**Verdict:** not used. Borrow the copy guidance.

### emilkowalski/skills (59k stars, active)

**What it contains.** Twenty markdown-only skills:
- motion: `review-animations`, `improve-animations` and others;
- `break-ui`, which stress-tests UI with worst-case data taken from real schema limits;
- `apple-design`, `mobile-native`, `pick-ui-library` and others.

**Methodology.** Very specific and checkable. `break-ui` works by "change the data, not the component", and reports before fixing.

**Fit.**
- Motion is a small concern for this app.
- `break-ui` is directly useful for seeding worst-case data.
- `pick-ui-library` suggests new dependencies.

**Verdict: `break-ui`'s CATALOG.md used as a reference** for the worst-case seed account. Nothing installed.

### Nutlope/hallmark (60k stars, v2.0.0)

**What it contains.** One skill with prompt, redesign and audit modes, 50 themes, and a `sloplint` checker that can render pages at 8 widths. `references/flow.md` § App screens is thoughtful: tables before cards, four data states, URL state.

**Problems.** Its non-waivable "Floor" rules conflict with our system:
- no tracked-caps labels;
- no middle-dot meta strings or status dots;
- **a required Hallmark stamp as the first line of the CSS**;
- `overflow-x: clip` on html and body.

It also needs a global `puppeteer-core`, can install a global hook, and overlaps Impeccable.

**Verdict:** not used.

### vercel-labs/agent-skills (35k stars)

**What it contains.** `web-design-guidelines` is two files: about 100 one-line rules covering accessibility, focus, forms, motion, typography, overflow, URL state, touch, dark mode, i18n and copy. It outputs terse `file:line` findings. The rules are pinned to upstream commit `434b7f9` with a SHA-256 checksum and never fetched at runtime. The repo also holds `react-best-practices` (performance), `composition-patterns` and deploy skills.

**Fit.** Good for a cheap, checkable code pass. Overrides needed for Warthog:
- sentence case, not Title Case;
- no `onKeyDown` requirement on native buttons;
- no new-dependency suggestions (`nuqs`, `virtua`).

**Verdict: selected.** The `web-design-guidelines` folder only, pinned at `5a37a63`.

### shadcn-ui/ui (129k stars)

**What it contains.** A component source, plus a skill that runs `npx shadcn@latest info` every time it loads, and an MCP server for installing registry components.

**Fit.** Adopting shadcn means Radix or Base UI, `cva`, `clsx` and `tailwind-merge`: several runtime dependencies and ADRs, and a second component vocabulary next to our own. Its components are excellent *reading material* for ARIA and state patterns. The Dialog, Switch and Table primitives we recommend can follow its behaviour without importing it.

**Verdict:** not used as a tool. Reference only.

### Other candidates found

**AccessLint/skills** (124 stars). Five skills: scan, inspect, audit (WCAG-EM), fix and diff.
- `shared/methodology.md` grades severity and evidence: verified, needs human confirmation, or human-only.
- `accessibility-inspect/references/checkpoints.md` is a good manual checklist.
- But the engine is `@accesslint/core`, run via unpinned `npx …@latest`, and adoption is small.
- **Verdict: the methodology and checkpoints are used. The engine is replaced by axe-core 4.11.0**, which is pinned, local and industry standard, injected by our capture harness.

**addyosmani/web-quality-skills** (3.1k stars). A Lighthouse-led workflow via Chrome DevTools MCP. Sound, but performance-led, and it duplicates axe for accessibility. **Not used.**

**OneRedOak/claude-code-workflows `design-review`** (3.9k stars). A seven-phase reviewer subagent with Playwright. But it gives the reviewer write tools, it is stale (August 2025), and its example pushes a dark palette. **Not used.** Our reviewers follow the same idea, read-only.

**snapsynapse/skill-a11y-audit** (2 stars). Axe plus Lighthouse with WCAG 2.2 mapping. Promising, but too new to rely on. **Not used.**

## Comparison

| Candidate | Audits an existing app | Redesign / implement | Information architecture | Accessibility depth | Needs | Hooks / network / global config | Conflict with Warthog's system | Methodology |
|---|---|---|---|---|---|---|---|---|
| **Impeccable** | Yes (critique, audit) | Yes (refine commands) | Partial (heuristics, cognitive load, distill) | Medium | Optional binary | Optional hooks, telemetry, `live` bypass | Medium (style bans) | **Strongest** |
| **Vercel web-design-guidelines** | Yes (code) | Lists fixes | URL state only | Code rules | None | None (pinned) | Low (3 overrides) | Checkable |
| **AccessLint** | Yes (live DOM) | `fix` | No | **High** (WCAG-EM) | Unpinned npx | Runtime downloads | None | **Rigorous** |
| **Emil `break-ui`** | Edge cases | Report first | No | No | None | None | Low | Very specific |
| Hallmark | Audit mode | Redesign | App-screen rules | Floor checks | Global puppeteer | Optional global hook | **High** | Marketing-first |
| ui-ux-pro-max | Lookup only | New design system | Some rules | Checklist | Python | Optional image APIs | **High** | Retrieval |
| taste-skill | No | Marketing sites | No | Contrast | Node, Chrome | Stop hook, fetches | **Total** | Generator |
| frontend-design | No | New identities | No | Floor | None | None | Medium | Good prose |
| shadcn skill / MCP | No | Swaps in shadcn | No | Via components | npx | Runs on load | **New dependencies** | Component rules |
| OneRedOak design-review | Yes (Playwright) | No | Light | Checklist | Playwright MCP | Reviewer can write | Low | Generic |

**Overlap.**
- Impeccable, Hallmark, taste-skill and frontend-design share one lineage aimed at avoiding the "AI look". Only Impeccable has a real *evaluation* method for app UI.
- Impeccable's `audit` partly covers both Vercel's rules and AccessLint.
- ui-ux-pro-max's checklist duplicates Vercel's rules.

**Gap.** None of these does real information-architecture research: card sorts, tree tests, analytics. The IA proposal in this audit is therefore a reasoned, task-based card sort plus heuristic evaluation. It should be validated with 5–8 real members using a first-click or tree test before it is built (see the [roadmap](redesign.md#7-implementation-roadmap)).

## Selected set and roles

| Tool | Role in this audit | Role afterwards | Installed where |
|---|---|---|---|
| **Impeccable** (critique rubric, audit, distill, clarify, layout, harden) | Method for the usability, information-architecture and visual reviewers (Nielsen scores, cognitive load, personas) | `/impeccable distill`, `clarify`, `layout` and `harden` on one page at a time during implementation, always with the Warthog design-system skill loaded first | `~/.claude_oren/skills/impeccable` (user level, pinned `b49177d`, no hooks; see `PINNED.txt`) |
| **Vercel web-design-guidelines** | Code-level rule pass with a `file:line` backlog | Run on changed files before each PR | `~/.claude_oren/skills/web-design-guidelines` (pinned `5a37a63`) |
| **axe-core 4.11.0 + AccessLint method** | Automated WCAG 2.2 A/AA checks on every capture at 390 and 1440px, plus a manual checklist (keyboard, zoom and reflow, targets, forms) | Re-run the harness on changed routes; axe results are diffable | axe-core in a scratch tool directory, not a Warthog dependency; the harness takes `AXE=<path>` |
| **Emil `break-ui` catalogue** | Defined the worst-case seed account: long names, 115 records, long unbroken strings, mixed currencies | The same account is reusable for regression | Not installed |

**Why this set.** The four tools complement each other without overlapping much:
- Impeccable judges what the evidence means.
- axe and the harness produce the evidence.
- Vercel's rules catch code-level slips.
- `break-ui` makes the evidence honest about real data.

None of them adds a runtime dependency to Warthog or touches its build. Warthog's own design-system skill stays the authority for every fix. Where a third-party rule conflicts with it, Warthog's wins. Examples: Impeccable's eyebrow ban and Inter warning; Vercel's Title Case rule.

**Deviation recorded honestly.** Impeccable's critique normally runs its own detector binary as "Assessment B". We did not run the binary. Our deterministic evidence came from the capture harness instead: axe, layout metrics and density metrics. By Impeccable's own definition that makes the critique "degraded" on the detector side. The design-review side ran as specified, in isolated sub-agents.

**Safety notes for later use.**
- Never run `impeccable live`. It can spawn `claude --permission-mode bypassPermissions`.
- Don't run `npx impeccable install`. It adds hooks that run even when commands are denied.
- If the launcher is ever run, it downloads a binary into `~/.impeccable/bin`. Leaving it unrun keeps the skill instruction-only.
