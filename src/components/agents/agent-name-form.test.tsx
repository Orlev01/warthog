// The "Name" panel in an agent's Settings section (docs/adr/agent-names-and-providers.md): the
// current name to edit, the limit the server applies, one Save, and the outcome in plain words.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentNameForm } from "./agent-name-form";

const noop = async (_formData: FormData): Promise<void> => {};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&rsquo;/g, "’").replace(/&quot;/g, "\"").replace(/\s+/g, " ");

test("the panel offers the agent's current name to edit, within the stored limit", () => {
  const html = renderToStaticMarkup(<AgentNameForm agentName="App on your computer" renameAction={noop} />);
  const input = /<input\b[^>]*name="name"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(input, /value="App on your computer"/);
  assert.match(input, /maxLength="200"/);
  assert.match(input, /required/);
  assert.match(html, /<label[^>]*>Agent name<\/label>/);
  assert.match(text(html), /Save name/);
  assert.match(text(html), /It doesn’t rename it in its own app/, "says the name is Warthog's label only");
  assert.doesNotMatch(html, /role="(alert|status)"[^>]*data-tone/, "no notice until something was saved");
});

test("the outcome of a save is shown in the panel", () => {
  const saved = renderToStaticMarkup(<AgentNameForm agentName="Codex" renameAction={noop} notice={{ tone: "success", text: "Name saved." }} />);
  assert.match(saved, /role="status"[^>]*data-tone="success"/);
  assert.match(text(saved), /Name saved\./);
  const problem = renderToStaticMarkup(<AgentNameForm agentName="Codex" renameAction={noop} notice={{ tone: "error", text: "We couldn't save that name." }} />);
  assert.match(problem, /role="alert"/);
});
