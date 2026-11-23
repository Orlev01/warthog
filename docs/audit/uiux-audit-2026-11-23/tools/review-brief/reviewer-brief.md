# Reviewer brief (read fully before starting)

You are one of seven specialist reviewers auditing the Warthog member app. Read the context brief first:
<scratch>/context/app-map.md

## Hard rules
- READ-ONLY on the app. Never edit, create or delete anything under
  <projects/warthog>/ (no git commands that change state).
  Your ONLY write is your findings JSON file in the scratchpad findings folder.
- Never call any `mcp__claude_ai_warthog__*` tool (that is the founder's PRODUCTION account).
- You may drive the local dev app at http://localhost:3241 with Playwright for live checks:
  import { open, clickWithStepUp, BASE } from
  "<scratch>/seed/browser.mjs";
  const { browser, page } = await open("typical" | "firstrun" | "worst", { width, height });
  Write throwaway scripts ONLY in your own folder: .../scratchpad/review/<your-lens>/ and run them with node.
  Do NOT approve, deny, disconnect, delete or change data in the "typical" account (other reviewers depend on
  it). Opening dialogs and cancelling them, typing into fields without saving, and switching tabs are fine.
  If you must test a destructive or saving flow, do it in the "worst" account and say so.
- Screenshots are already captured (see Evidence locations in app-map.md). Look at the images with the Read
  tool — that is the primary evidence. Read source code to explain *why* and to give precise locations.
  Budget your image reads: prefer s1/s2 slices; don't read every slice of every page.
- Be critical and honest; do not assume the existing design is good. But be concrete: every finding must
  point at a specific page/component and give evidence (screenshot path and/or file:line, or a metric).
  No vague advice ("make it cleaner"). Recommendations must be specific and implementable in this codebase
  (no new npm dependencies; reuse/extend existing primitives in src/components/ui and src/components/shell).
- Respect the founder decisions in app-map.md (IA can change freely; visual direction is refined, not replaced).
- Skip anything already fixed by the 12 Nov pass unless you see a concrete regression.
- Prefer fewer, higher-quality findings over many trivial ones: aim for 15–30 findings, each distinct.
  Merge repeated instances of one pattern into one finding listing several locations.

## Severity scale (use exactly)
- critical: blocks or seriously endangers a core job (approve a request, connect/disconnect an agent, see what
  agents did, control spending), causes data loss, or a WCAG 2.2 AA failure that blocks a task.
- high: substantial confusion, wasted effort or mistrust on a frequent path; structural problem affecting
  many pages; WCAG AA failure on a key page.
- medium: noticeable friction or inconsistency on a less frequent path; local structural issue.
- low: polish, minor inconsistency.

## Output (write exactly this JSON shape)
File: <scratch>/findings/<your-lens>.json
{
  "lens": "<your lens>",
  "summary": "3–6 sentences: the overall verdict through your lens",
  "scores": { ... optional lens-specific scores, e.g. Nielsen heuristics 0–4 ... },
  "strengths": ["2–5 things that genuinely work and must be preserved"],
  "findings": [
    {
      "id": "<LENS-PREFIX>-01",
      "title": "short statement of the problem",
      "location": "page/route + component, e.g. /inbox — src/components/inbox/inbox-view.tsx:340",
      "problem": "what is wrong, concretely",
      "why": "why it is a problem (principle/heuristic/WCAG criterion)",
      "impact": "what it costs the user (and which persona)",
      "severity": "critical|high|medium|low",
      "recommendation": "the specific change",
      "effort": "S|M|L  (S < half a day, M 1–3 days, L > 3 days)",
      "type": "structural|visual|functional",
      "evidence": ["screenshot path(s)", "file:line", "metric e.g. life-admin light-390: 1,997 words, 697 controls"],
      "related_pages": ["other routes with the same problem"]
    }
  ]
}

Return to the caller only a short summary (under 250 words): your verdict, your top 5 findings by severity,
and the path of your JSON file.
