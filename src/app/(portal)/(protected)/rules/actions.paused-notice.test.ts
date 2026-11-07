// E18-S20 — the Rules screen's "paused" outcome notice must be HONEST (the E12-S17 review
// veto: the paused notice says "…until you resume it" while no Resume control exists
// anywhere, and the rules store has no resume primitive to back one).
//
// RED-first: the paused notice copy is a page concern, but a Next `page.tsx` entry file may
// export only its framework fields — so, exactly as the security and activity screens do
// (`settings/security/notices.ts` → `securityNotice`, `activity/notices.ts` →
// `activityNotice`), the code→copy resolver belongs in the page's testable sibling. The
// page's touched sibling here is `./actions`; it does not yet export a `rulesNotice` seam,
// so importing it fails until the builder adds the resolver and rewords the paused copy so
// it no longer promises resuming. These assert BEHAVIOUR (the copy the resolver returns),
// never the source text of any module.

import { test } from "node:test";
import assert from "node:assert/strict";

import { rulesNotice } from "./actions";

test("the 'paused' outcome notice does not promise resuming (no Resume control exists)", () => {
  const notice = rulesNotice("paused");
  assert.ok(notice, "a 'paused' outcome must map to a plain-words notice");
  assert.equal(notice!.tone, "done", "pausing a rule is a successful outcome, not a problem");
  assert.ok(notice!.text.trim().length > 0, "the paused notice carries plain-words copy");
  assert.ok(
    !/\bresum(?:e|es|ed|ing)\b/i.test(notice!.text),
    `the paused notice must not promise resuming while no Resume control is shown; got "${notice!.text}"`,
  );
});

test("an unknown notice code maps to nothing (the query string can never inject copy)", () => {
  assert.equal(
    rulesNotice("definitely-not-a-real-code"),
    null,
    "an absent/unknown notice code renders no copy",
  );
});
