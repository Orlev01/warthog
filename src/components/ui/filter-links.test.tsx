// Shared organisation controls for list pages (`./filter-links`, `./list-group`): view and
// quick-filter links, removable filter chips and titled groups. Plain links and native
// disclosures only, so state survives reloads and Back/Forward.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActiveFilters, FilterLinks } from "./filter-links";
import { ListGroup, LIST_ROW } from "./list-group";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

test("filter links mark only the current one and show counts as text", () => {
  const html = render(
    <FilterLinks
      label="Activity views"
      items={[
        { label: "Timeline", href: "/activity", active: true },
        { label: "By agent", href: "/activity?view=agents", active: false, count: 3 },
      ]}
    />,
  );
  assert.match(html, /<nav aria-label="Activity views"/);
  assert.match(html, /href="\/activity" aria-current="page"/);
  assert.doesNotMatch(html, /view=agents" aria-current/);
  assert.match(html, />3<\/span>/);
  assert.doesNotMatch(html, /role="tab"/, "links, not ARIA tabs");
});

test("each applied filter is a link that removes only that filter, with a unique accessible name", () => {
  const html = render(
    <ActiveFilters
      clearHref="/activity?view=agents"
      filters={[
        { label: "Agent: Claude", removeHref: "/activity?type=read" },
        { label: "Type: Reads", removeHref: "/activity?agent=a1" },
      ]}
    />,
  );
  assert.match(html, /href="\/activity\?type=read"[^>]*><span class="sr-only">Remove filter <\/span>Agent: Claude/);
  assert.match(html, /href="\/activity\?agent=a1"[^>]*><span class="sr-only">Remove filter <\/span>Type: Reads/);
  assert.match(html, /href="\/activity\?view=agents"[^>]*>Clear all filters/);
  assert.equal(render(<ActiveFilters clearHref="/x" filters={[]} />), "", "nothing applied renders nothing");
});

test("a group has a labelled heading at the caller's level, its count and divider rows", () => {
  const html = render(
    <ListGroup id="g-today" title="Today" count={2} level={3}>
      <li className={LIST_ROW}>One</li>
    </ListGroup>,
  );
  assert.match(html, /<section aria-labelledby="g-today-heading"/);
  assert.match(html, /<h3 id="g-today-heading"[^>]*>Today<\/h3>/);
  assert.match(html, />2<\/span>/);
  assert.match(html, /<ul role="list"/);
});

test("a collapsible group is a native disclosure, closed unless asked to open", () => {
  const closed = render(<ListGroup id="done" title="Done" count={4} collapsible><li>x</li></ListGroup>);
  assert.match(closed, /<details class="group"><summary/);
  assert.doesNotMatch(closed, /<details open/);
  const open = render(<ListGroup id="done" title="Done" collapsible defaultOpen><li>x</li></ListGroup>);
  assert.match(open, /<details open=""/);
});
