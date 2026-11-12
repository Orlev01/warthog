# Brand marks, a workspace accent and collapsible connector modules

Decision: 12 November 2026, at the founder's request ("everything feels very
monotone and homogeneous … I don't want rainbow colours … just a sensible amount
for helping with lines and icons … where we have known brands like Gmail and Claude
use their actual icon and colours"). This amends the neutral-only palette of the
[admin console design](admin-console-design.md) inside the signed-in workspace; the
public front door is unchanged.

## Colour

- One **workspace accent** (`--wh-tint`, an indigo) for lines and wayfinding: the
  active sidebar item, active tab, panel icons, timeline markers, checkboxes and
  focus-adjacent emphasis. Text stays neutral; primary buttons stay neutral.
- **Semantic tones** carry meaning, never decoration: `--wh-info` (reads),
  `--wh-warning` (changes, waiting), `--wh-success` (done), `--wh-danger` (blocked,
  failed). Soft fills are derived with `color-mix` against the surface, so badges keep
  neutral text at full contrast. Meaning is always words plus an icon.
- Tokens live in `workspace.css` with `light-dark()` values and forced-colours
  fallbacks. Markup never carries a raw hex value.

## Brand marks

- Known services and agent platforms show their own mark (`BrandMark`): the owner's
  official multi-colour icon where one is published (Gmail, Google Calendar, Google
  Drive, Outlook, OneDrive, ChatGPT), otherwise a Simple Icons (CC0) glyph in the
  brand's colour. Marks identify the service only; they are trademarks of their owners.
- Marks sit on a fixed light tile so dark and black logos stay legible in both themes.
  Unknown brands get a neutral initial tile, never a guessed logo.
- Files are static, sanitised SVGs in `public/brands/`, served same-origin and
  rendered as decorative images next to the visible name.

## Modular connector access

An agent's Connectors section lists each service as its own collapsible module. The
collapsed header shows the mark, name, chosen account, whether the agent may use it
and a one-line access summary; expanding it shows the account, read/change policy and
tool choices. Tools read in plain words with their identifiers secondary. Every
control keeps its existing `name`, so the save path is unchanged.
