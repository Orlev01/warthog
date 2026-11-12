import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RulesView, createRuleBuilderState, updateRuleBuilder, isRuleBuilderComplete } from "./rules-view";
import { ruleInputFromForm } from "@/app/(portal)/(protected)/rules/actions";
import { ruleLabelsFromChoices } from "./rules-organise";

test("changing a rule action and condition exposes matching required fields and updates the preview", () => {
  let state = createRuleBuilderState();
  state = updateRuleBuilder(state, { type: "action", action: "specific_tool" });
  assert.equal(isRuleBuilderComplete(state), false);
  state = updateRuleBuilder(state, { type: "target", value: "mail.send" });
  state = updateRuleBuilder(state, { type: "condition", condition: "recipient_in_domain" });
  assert.equal(isRuleBuilderComplete(state), false);
  state = updateRuleBuilder(state, { type: "detail", value: "example.com" });
  state = updateRuleBuilder(state, { type: "template", template: "never_allow" });
  state = updateRuleBuilder(state, { type: "scope", scope: { type: "agent", agentId: "agent-one", name: "Helper" } });
  assert.equal(isRuleBuilderComplete(state), true);
  // The tool is chosen from the real ones the page passes (UI/UX pass, interaction-11).
  const toolChoices = [{ label: "Mail", choices: [{ value: "mail.send", label: "Mail: send" }] }];
  assert.equal(isRuleBuilderComplete(state, { tools: toolChoices }), true);
  const markup = renderToStaticMarkup(<RulesView rules={[]} agents={[{ id: "agent-one", name: "Helper" }]} draft={state.draft} toolChoices={toolChoices} />);
  assert.match(markup, /<select[^>]*name="rule-target"/); assert.match(markup, /<option value="mail.send" selected="">Mail: send<\/option>/); assert.match(markup, /name="rule-condition-detail"/); assert.match(markup, /value="example.com"/);
  assert.match(markup, /Never allow/); assert.match(markup, /Helper/);
  const form = new FormData(); for (const [key, value] of Object.entries({ "rule-template": "never_allow", "rule-action": "specific_tool", "rule-target": "mail.send", "rule-condition": "recipient_in_domain", "rule-condition-detail": state.detail, "rule-scope": "agent-one" })) form.set(key, value);
  const input = ruleInputFromForm(form);
  assert.deepEqual(input.action, { type: "specific_tool", tool: "mail.send" });
  assert.deepEqual(input.condition, { type: "recipient_in_domain", domain: "example.com" });
});
test("changing conditions and actions clears incompatible details and invalid amounts cannot be submitted", () => {
  let state = updateRuleBuilder(createRuleBuilderState(), { type: "condition", condition: "recipient_is" });
  state = updateRuleBuilder(state, { type: "detail", value: "someone@example.com" });
  state = updateRuleBuilder(state, { type: "condition", condition: "amount_over" });
  assert.equal(state.detail, ""); assert.equal(isRuleBuilderComplete(state), false);
  state = updateRuleBuilder(state, { type: "detail", value: "-1" }); assert.equal(isRuleBuilderComplete(state), false);
  state = updateRuleBuilder(state, { type: "detail", value: "Infinity" }); assert.equal(isRuleBuilderComplete(state), false);
  state = updateRuleBuilder(state, { type: "detail", value: "25.50" }); assert.equal(isRuleBuilderComplete(state), true);
  const markup = renderToStaticMarkup(<RulesView rules={[]} agents={[]} draft={state.draft} currency="NZD" />);
  assert.match(markup, /account currency \(NZD\)/); assert.match(markup, /Amount \(NZD\)/);
  state = updateRuleBuilder(state, { type: "condition", condition: "none" });
  assert.equal("condition" in state.draft ? state.draft.condition : undefined, undefined);
  state = updateRuleBuilder(state, { type: "action", action: "service_tool" });
  state = updateRuleBuilder(state, { type: "target", value: "gmail" });
  state = updateRuleBuilder(state, { type: "action", action: "specific_tool" });
  assert.equal(isRuleBuilderComplete(state), false);
});

// UI/UX pass (interaction-11): a specific tool or a service is chosen from the real ones, so a
// name that isn't offered (a typo, a made-up tool) can never complete the draft.
test("a tool or service that isn't one of the real choices can't complete the draft", () => {
  const tools = [{ label: "Warthog", choices: [{ value: "create_task", label: "Create a task" }] }];
  const services = [{ label: "Services", choices: [{ value: "google-gmail", label: "Gmail" }] }];
  let state = updateRuleBuilder(createRuleBuilderState(), { type: "action", action: "specific_tool" });
  state = updateRuleBuilder(state, { type: "target", value: "totally_made_up_tool" });
  assert.equal(isRuleBuilderComplete(state, { tools, services }), false, "an unknown tool");
  state = updateRuleBuilder(state, { type: "target", value: "create_task" });
  assert.equal(isRuleBuilderComplete(state, { tools, services }), true, "a real tool");
  state = updateRuleBuilder(state, { type: "action", action: "service_tool" });
  state = updateRuleBuilder(state, { type: "target", value: "gmial" });
  assert.equal(isRuleBuilderComplete(state, { tools, services }), false, "an unknown service");
  state = updateRuleBuilder(state, { type: "target", value: "google-gmail" });
  assert.equal(isRuleBuilderComplete(state, { tools, services }), true, "a real service");

  // The builder shows the choices, never a free-text field, and an unknown draft value is not selected.
  const markup = renderToStaticMarkup(
    <RulesView rules={[]} agents={[]} draft={{ template: "never_allow", scope: { type: "any_agent" }, action: { type: "specific_tool", tool: "totally_made_up_tool" } }} toolChoices={tools} />,
  );
  assert.doesNotMatch(markup, /<input[^>]*name="rule-target"/);
  assert.match(markup, /<option value="" selected="">Choose a tool<\/option>/);
  assert.match(markup, /<optgroup label="Warthog"><option value="create_task">Create a task<\/option><\/optgroup>/);
  assert.doesNotMatch(markup, /totally_made_up_tool/);
  assert.match(markup, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>[\s\S]*?Add rule<\/button>/, "Add rule is unavailable until a real tool is chosen");
});

// UI/UX follow-up: the preview names a tool by its title and a service by its catalogue
// name, the same labels the choices show (and the saved rule's sentence uses), never the id.
test("the preview names the chosen tool by its title and the chosen service by its name", () => {
  const tools = [
    { label: "Warthog", choices: [{ value: "create_task", label: "Create a task" }] },
    { label: "Gmail", choices: [{ value: "google-gmail__send", label: "Gmail: Send email" }] },
  ];
  const services = [{ label: "Your connected services", choices: [{ value: "google-gmail", label: "Gmail" }] }];
  const preview = (draft: React.ComponentProps<typeof RulesView>["draft"]) => {
    const markup = renderToStaticMarkup(<RulesView rules={[]} agents={[]} draft={draft} toolChoices={tools} serviceChoices={services} />);
    return /<p class="text-fg" aria-live="polite">([\s\S]*?)<\/p>/.exec(markup)?.[1] ?? "";
  };
  const any = { type: "any_agent" } as const;
  assert.equal(preview({ template: "ask_first", scope: any, action: { type: "specific_tool", tool: "create_task" } }), "Ask me before any agent uses Create a task");
  assert.equal(preview({ template: "ask_first", scope: any, action: { type: "service_tool", service: "google-gmail" } }), "Ask me before any agent uses any Gmail tool");
  assert.equal(
    preview({ template: "never_allow", scope: { type: "agent", agentId: "c1", name: "Helper" }, action: { type: "specific_tool", tool: "google-gmail__send" } }),
    "Never allow Helper to use Gmail: Send email",
  );
});

test("the preview's labels come from the choices; an id they don't hold is shown as it is", () => {
  const labels = ruleLabelsFromChoices(
    [{ label: "Warthog", choices: [{ value: "create_task", label: "Create a task" }] }],
    [{ label: "Services", choices: [{ value: "google-gmail", label: "Gmail" }] }],
  );
  assert.equal(labels.toolTitle?.("create_task"), "Create a task");
  assert.equal(labels.serviceName?.("google-gmail"), "Gmail");
  assert.equal(labels.toolTitle?.("google-gmail"), undefined, "a service id is not a tool");
  assert.equal(labels.toolTitle?.("retired_tool"), undefined);
  assert.equal(labels.serviceName?.("gone-service"), undefined);
  const none = ruleLabelsFromChoices(undefined, undefined);
  assert.equal(none.toolTitle?.("create_task"), undefined);
});
