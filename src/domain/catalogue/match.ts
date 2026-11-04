// E03-S12 — Name normalisation and alias matching.
//
// The shared matcher that decides "does this catalogue entry match that request?"
// (brief "Request a connector", design §7): when a person requests a service that
// is not yet in the catalogue and an entry whose name or aliases match is LATER
// added, the person is notified. Both sides are compared ignoring case and
// punctuation.
//
// Pure domain module (CLAUDE.md / conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). Matching a name is a pure function of its
// inputs.

// Normalise a name for comparison: fold case, replace every run of non-alphanumeric
// characters (punctuation, whitespace) with a single space, and trim. This ignores
// case and punctuation while keeping word boundaries that a separator marks, so
// "Google Drive!", "  google  drive  " and "(GOOGLE: DRIVE)" all become "google
// drive". Unicode-aware so letters/digits outside ASCII survive and everything else
// (including curly quotes) is treated as a separator.
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// True when `requestedName` matches the entry's `name` OR any of its `aliases`,
// ignoring case and punctuation. The entry param is structural (just name +
// aliases), so a full CatalogueEntry from ./schema satisfies it directly.
export function matchesRequest(
  requestedName: string,
  entry: { name: string; aliases: string[] },
): boolean {
  const requested = normalise(requestedName);
  if (normalise(entry.name) === requested) {
    return true;
  }
  return entry.aliases.some((alias) => normalise(alias) === requested);
}
