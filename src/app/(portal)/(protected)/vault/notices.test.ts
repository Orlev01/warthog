// About you's outcome notices (./notices): what the page says after Add or Not mine on a
// suggestion, and where those actions return to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutYouNotice, aboutYouReturnUrl } from "./notices";

test("adding or declining a suggestion says what happened", () => {
  assert.deepEqual(aboutYouNotice("suggestion_added"), { tone: "success", text: "Added to About you." });
  assert.deepEqual(aboutYouNotice("suggestion_declined"), { tone: "success", text: "Removed. It won't be suggested again." });
});

test("a suggestion that's no longer waiting, or a failed change, says nothing changed and what to do", () => {
  const gone = aboutYouNotice("suggestion_gone");
  assert.equal(gone?.tone, "error");
  assert.match(gone!.text, /no longer waiting/);
  assert.match(gone!.text, /nothing was changed/i);
  const problem = aboutYouNotice("problem");
  assert.equal(problem?.tone, "error");
  assert.match(problem!.text, /try again/i);
  assert.doesNotMatch(problem!.text, /something went wrong/i);
});

test("only a known notice is shown", () => {
  for (const value of [undefined, ["suggestion_added"], "", "toString", "__proto__", "<script>"]) {
    assert.equal(aboutYouNotice(value), null);
  }
});

test("Add and Not mine return to About you with their notice", () => {
  assert.equal(aboutYouReturnUrl("suggestion_added"), "/vault?notice=suggestion_added");
  assert.equal(aboutYouReturnUrl("suggestion_declined"), "/vault?notice=suggestion_declined");
});
