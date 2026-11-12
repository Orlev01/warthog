import * as React from "react";

// ListToolbar — everything that narrows one list, in one bounded strip and always in the
// same order: the view switch, quick filters, the search form beside its "Filters"
// disclosure, the applied-filter chips with "Clear all", then a one-line status
// ("Showing one entry.", "0 of 0 library items"). It's a labelled region, not a form: the
// view switch and chips are links, so put the GET <form> in `search` (with no card or border
// of its own) and keep links outside it. Every slot is optional; an empty toolbar renders
// nothing. Styles: surfaces.css (.wh-toolbar).

export function ListToolbar({
  label,
  views,
  filters,
  search,
  more,
  applied,
  status,
  children,
}: {
  // Names the region for assistive technology, e.g. "Find activity".
  label: string;
  // A FilterLinks view switch (variant "tabs").
  views?: React.ReactNode;
  // Quick filters: a FilterLinks row (variant "chips" or "scroll").
  filters?: React.ReactNode;
  // The search form (GET), with its field and submit.
  search?: React.ReactNode;
  // A "Filters" <details> disclosure with the less common filters, beside the search.
  more?: React.ReactNode;
  // <ActiveFilters> — renders nothing when no filter is applied.
  applied?: React.ReactNode;
  // A short live summary of what the list shows; announced politely when it changes.
  status?: React.ReactNode;
  // Anything else that narrows this list, after the applied filters.
  children?: React.ReactNode;
}) {
  if (!views && !filters && !search && !more && !applied && !status && !children) return null;
  return (
    <section aria-label={label} className="wh-toolbar">
      {views ? <div className="wh-toolbar-row">{views}</div> : null}
      {filters ? <div className="wh-toolbar-row">{filters}</div> : null}
      {search || more ? (
        <div className="wh-toolbar-row wh-toolbar-search">
          {search ? <div className="wh-toolbar-search-field">{search}</div> : null}
          {more ? <div className="wh-toolbar-more">{more}</div> : null}
        </div>
      ) : null}
      {applied}
      {children}
      {status ? (
        <p role="status" className="wh-toolbar-status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
