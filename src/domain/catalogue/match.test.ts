// E03-S12 — Name normalisation and alias matching (`src/domain/catalogue/match.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional (test-first) — the builder writes the matcher
// AFTERWARDS to turn these green. Do NOT add the module to make them pass; the
// builder does that. These tests pin BEHAVIOUR (what the matcher returns for a
// requested name against an entry's name/aliases), never the source text of the
// module, so a later rename or refactor that preserves behaviour must not redden
// them.
//
// Pure domain module (CLAUDE.md / conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). Matching a name is a pure function of its
// inputs.
//
// WHY this matcher exists (brief "Request a connector"): when a person requests a
// service that is not in the catalogue, the request is recorded as "Requested"; when
// a catalogue entry is LATER added "whose name or listed aliases match the requested
// service name (ignoring case and punctuation)", the person is notified. This is the
// one shared matcher that decides "does this entry match that request?" — reused by
// the notify path (design §7, catalogue = data files with id/name/aliases/…).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements EXACTLY this):
//
//   // True when `requestedName` matches the entry's `name` OR any of its `aliases`,
//   // ignoring case and punctuation. The entry param is structural (just name +
//   // aliases), so a full CatalogueEntry from ./schema satisfies it directly.
//   function matchesRequest(
//     requestedName: string,
//     entry: { name: string; aliases: string[] },
//   ): boolean;
//
// NORMALISATION IS INTENTIONALLY UNDER-SPECIFIED. "Ignoring case and punctuation"
// admits more than one reasonable normaliser (strip every non-alphanumeric char;
// OR replace punctuation with a space and collapse). These differ ONLY when the
// requested text OMITS a separator the stored value keeps (e.g. "GoogleDrive" vs
// "google drive"). So every case below is one that EVERY such normaliser agrees on
// — case folding, leading/trailing/wrapping punctuation, punctuation sitting beside
// an existing space, and whitespace collapse/trim. We deliberately do NOT assert on
// the omitted-separator case, so a correct-per-acceptance build is never reddened
// for a choice the requirement leaves open.

import { test } from "node:test";
import assert from "node:assert/strict";

import { matchesRequest } from "./match";

// A representative catalogue entry. Its NAME ("Google Drive") differs from the
// lower-cased alias ("google drive") so a test can isolate alias matching from name
// matching, and it carries sibling aliases to prove the matcher scans the whole list.
const googleDrive = {
  name: "Google Drive",
  aliases: ["google drive", "gdrive", "drive"],
};

// --- The acceptance criteria, stated directly ------------------------------------

test("'Google Drive!' matches the alias 'google drive' (case + trailing punctuation ignored)", () => {
  // The headline acceptance example. 'Google Drive!' differs from the alias only by
  // case and a trailing '!', both of which must be ignored.
  assert.equal(matchesRequest("Google Drive!", googleDrive), true);
});

test("an unrelated requested name does not match", () => {
  assert.equal(matchesRequest("Slack", googleDrive), false);
  assert.equal(matchesRequest("Dropbox", googleDrive), false);
});

// --- Matching against the NAME (not only aliases) --------------------------------

test("matches the entry name ignoring case", () => {
  assert.equal(matchesRequest("GOOGLE DRIVE", googleDrive), true);
  assert.equal(matchesRequest("google drive", googleDrive), true);
  assert.equal(matchesRequest("Google Drive", googleDrive), true);
});

test("matches a short alias that is not the name", () => {
  // "gdrive" / "drive" are aliases, never the display name — proves alias scanning.
  assert.equal(matchesRequest("GDrive", googleDrive), true);
  assert.equal(matchesRequest("Drive", googleDrive), true);
});

// --- Punctuation is ignored (only forms every reasonable normaliser agrees on) ----

test("trailing and leading punctuation is ignored", () => {
  assert.equal(matchesRequest("Google Drive.", googleDrive), true);
  assert.equal(matchesRequest("...Google Drive", googleDrive), true);
  assert.equal(matchesRequest("Google Drive!!!", googleDrive), true);
});

test("wrapping punctuation is ignored", () => {
  assert.equal(matchesRequest("(Google Drive)", googleDrive), true);
  assert.equal(matchesRequest("“Google Drive”", googleDrive), true);
});

test("punctuation sitting beside an existing space is ignored", () => {
  // The ':' is adjacent to the space that already separates the two words, so every
  // reasonable normaliser collapses it back to "google drive".
  assert.equal(matchesRequest("Google: Drive", googleDrive), true);
  assert.equal(matchesRequest("Google , Drive", googleDrive), true);
});

// --- Whitespace is normalised ----------------------------------------------------

test("leading and trailing whitespace is trimmed", () => {
  assert.equal(matchesRequest("   Google Drive   ", googleDrive), true);
});

test("runs of inner whitespace collapse", () => {
  assert.equal(matchesRequest("Google    Drive", googleDrive), true);
  assert.equal(matchesRequest("Google\tDrive", googleDrive), true);
});

// --- BOTH sides are normalised ---------------------------------------------------

test("the stored name/aliases are normalised too, not just the request", () => {
  // Here the STORED values carry the case and punctuation while the request is clean,
  // proving normalisation is applied to the entry side as well.
  const messyEntry = {
    name: "Google Drive!",
    aliases: ["  G-Suite Drive  ", "GOOGLE DRIVE"],
  };
  assert.equal(matchesRequest("google drive", messyEntry), true);
});

// --- Entries with no aliases -----------------------------------------------------

test("an entry with an empty alias list still matches on its name", () => {
  const noAliases = { name: "Notion", aliases: [] as string[] };
  assert.equal(matchesRequest("notion", noAliases), true);
  assert.equal(matchesRequest("NOTION.", noAliases), true);
});

test("an entry with no aliases does not match an unrelated request", () => {
  const noAliases = { name: "Notion", aliases: [] as string[] };
  assert.equal(matchesRequest("Linear", noAliases), false);
});

// --- A near-miss that shares a word but is not the same service ------------------

test("a different multi-word service sharing one word does not match", () => {
  // "Google Calendar" shares the word "Google" with the Google Drive entry but is a
  // distinct service — the whole normalised name must match, not a single token.
  assert.equal(matchesRequest("Google Calendar", googleDrive), false);
});
