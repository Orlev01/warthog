import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Bot } from "lucide-react";
import { ActionBar, WorkspaceHeading, WorkspacePanel } from "./workspace-surfaces";
import { WorkspaceContext } from "./workspace-context";
import { ListToolbar } from "@/components/ui/list-toolbar";

test("the heading band needs only a title; eyebrow, description, meta, actions and nav are optional slots", () => {
  const bare = renderToStaticMarkup(<WorkspaceHeading title="Inbox" />);
  assert.match(bare, /^<header class="wh-page-heading"><div class="wh-page-heading-main"><div class="wh-page-heading-text"><h1>Inbox<\/h1><\/div><\/div><\/header>$/);
  const full = renderToStaticMarkup(
    <WorkspaceHeading
      eyebrow="Agents"
      title="Connect an agent"
      description={<><p>First.</p><p>Second.</p></>}
      meta="2 agents"
      nav={<nav aria-label="Views">tabs</nav>}
    >
      <a href="/x">Act</a>
    </WorkspaceHeading>,
  );
  assert.match(full, /<p class="wh-eyebrow">Agents<\/p><h1>Connect an agent<\/h1>/);
  assert.match(full, /<div class="wh-page-description"><p>First\.<\/p><p>Second\.<\/p><\/div>/, "a rich description is a block");
  assert.match(full, /<p class="wh-page-meta">2 agents<\/p>/);
  assert.match(full, /<div class="wh-heading-actions"><a href="\/x">Act<\/a><\/div>/);
  assert.match(full, /<div class="wh-page-heading-nav"><nav aria-label="Views">tabs<\/nav><\/div><\/header>$/);
  assert.match(renderToStaticMarkup(<WorkspaceHeading title="T" description="One line." />), /<p class="wh-page-description">One line\.<\/p>/);
});

test("on account resource pages the band carries the agent-scope row; elsewhere, or with scope={false}, it doesn't", () => {
  const within = (pathname: string, node: React.ReactNode) =>
    renderToStaticMarkup(
      <WorkspaceContext.Provider value={{ pathname, agents: [{ id: "a1", name: "Dev console" }] }}>{node}</WorkspaceContext.Provider>,
    );
  const memory = within("/memory", <WorkspaceHeading title="Memory" />);
  assert.match(memory, /<div role="group" aria-label="Agent scope" class="wh-heading-scope wh-scope">/);
  assert.match(memory, /href="\/agents\/a1\?section=memory"/);
  assert.doesNotMatch(within("/home", <WorkspaceHeading title="Home" />), /Agent scope/);
  assert.doesNotMatch(within("/memory", <WorkspaceHeading title="Memory" scope={false} />), /Agent scope/);
  assert.doesNotMatch(renderToStaticMarkup(<WorkspaceHeading title="Memory" />), /Agent scope/, "no provider, no row");
});

test("a panel's icon is optional and its footer is an action bar along the bottom edge", () => {
  const plain = renderToStaticMarkup(<WorkspacePanel title="Export">Body</WorkspacePanel>);
  assert.doesNotMatch(plain, /wh-panel-icon/);
  assert.match(plain, /<section aria-labelledby="([^"]+)" class="wh-panel"><header class="wh-panel-header"><div class="wh-panel-title"><h2 id="\1">Export<\/h2><\/div><\/header><div class="wh-panel-body">Body<\/div><\/section>/);
  const footed = renderToStaticMarkup(
    <WorkspacePanel title="Agents" icon={Bot} description="Rich" footer={<button>Save</button>} headingLevel={3}>
      Body
    </WorkspacePanel>,
  );
  assert.match(footed, /<span class="wh-panel-icon"><svg/);
  assert.match(footed, /<h3 id=/);
  assert.match(footed, /<p class="wh-panel-description">Rich<\/p>/);
  assert.match(footed, /<footer class="wh-panel-footer"><button>Save<\/button><\/footer><\/section>$/);
});

test("the action bar keeps a blocking note beside the buttons it explains", () => {
  const html = renderToStaticMarkup(<ActionBar note="Add a budget before you can save card access."><button disabled>Save changes</button></ActionBar>);
  assert.match(html, /^<div class="wh-form-actions"><div class="wh-form-actions-buttons"><button disabled="">Save changes<\/button><\/div><p class="wh-form-actions-note">Add a budget/);
});

test("the list toolbar keeps one order: views, quick filters, search beside more filters, applied, status", () => {
  const html = renderToStaticMarkup(
    <ListToolbar
      label="Find activity"
      status="Showing one entry."
      applied={<div>APPLIED</div>}
      more={<details>MORE</details>}
      search={<form>SEARCH</form>}
      filters={<nav>QUICK</nav>}
      views={<nav>VIEWS</nav>}
    />,
  );
  assert.match(html, /^<section aria-label="Find activity" class="wh-toolbar">/);
  const order = ["VIEWS", "QUICK", "SEARCH", "MORE", "APPLIED", "Showing one entry."].map((t) => html.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /<p role="status" class="wh-toolbar-status">Showing one entry\.<\/p>/);
  assert.equal(renderToStaticMarkup(<ListToolbar label="Empty" />), "");
});
