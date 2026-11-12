# Keep every piece of text inside a component

Decision: 12 November 2026, following the founder's request for a complete UI/UX pass: "There
should not be any free text on the background but always within a compartment or component of
some sort." It refines [workspace depth](../design/workspace-depth.md) and the
[public front door](../design/public-front-door.md); where they differ, this decision wins.

## Rule

No visible text has the page canvas as its nearest container. Page titles, eyebrows,
descriptions, summary lines, helper copy, section labels, empty states, errors, footnotes, legal
lines and inline Back/Cancel links all sit inside a bounded component: the heading band, a panel,
a list group, the list toolbar, a notice, an empty state, a tab strip, a top bar, the sidebar or
drawer, a dialog, a toast or a footer bar. The canvas is only the backdrop between components.
The rule covers the signed-in workspace, account entry, consent, status screens and the public
pages (marketing copy sits in bounded bands, panels or cards).

## How

Containment comes from the shared primitives, not per-page wrappers: `WorkspaceHeading` is a
bounded band with `meta` and `nav` slots; `WorkspacePanel` carries an optional footer action bar;
`ListGroup` is a panel with divider rows and drops to a plain sub-section when nested; one
`ListToolbar` holds the view switch, filters, search and applied chips; `PageNotice` is the single
outcome slot; `EmptyState` always names the next step. Styles live in `src/app/surfaces.css`
(workspace), `src/app/controls.css` (controls) and `src/app/public.css` (public and entry
screens), loaded after `globals.css`.

The depth model is unchanged: canvas → panel → inset. Containment never means a card around every
paragraph or card-in-card nesting; related rows share one panel and are separated by dividers.

## Verification

UI reviews measure it: for each visible text node, walk up to the nearest ancestor with its own
background (different from the canvas), a three-sided border, a shadow or an image; if that
ancestor is the canvas itself, the text is free. The UI/UX pass audit kit implements this check
and runs it per screen, width and theme.
