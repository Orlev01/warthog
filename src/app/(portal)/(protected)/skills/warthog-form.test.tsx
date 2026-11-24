// What the Skills page's Warthog-skill forms post, and that a posted form reaches the seam
// (`./warthog-form`, read by the `changeWarthogSkillAction` server action in `page.tsx`;
// docs/adr/editable-builtin-skills.md).
//
// A Next page that reads the session cookie can't be rendered here, so, as in the sibling
// actions tests, the page's wiring is pinned on its pure parts: the rendered <WarthogSkills/>
// forms are "posted" by collecting the fields a browser would send, parsed by the same
// function the server action uses, and handed to the real `changeWarthogSkill` over an
// in-memory PGlite with the real migrations. The loader then reads the change back.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createSkillsActions } from "./actions";
import { warthogNotice, warthogReturn, warthogSkillChange } from "./warthog-form";
import { WarthogSkills } from "@/components/skills/warthog-skills";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { localAesKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Session } from "@/server/auth/session";

// --- markup → the FormData a browser posts ------------------------------------------

function decode(s: string): string {
  return s.replace(/&#x27;|&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"));
  return m ? decode(m[1]!) : null;
}
function has(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=""|="${name}")?(?=\\s|/|>|$)`, "i").test(` ${attrs}`);
}

// The rendered form for this skill and change, by its hidden fields.
function formFor(markup: string, key: string, change: string): string {
  const form = [...markup.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]).find(
    (f) => f.includes(`name="key" value="${key}"`) && f.includes(`name="change" value="${change}"`),
  );
  assert.ok(form, `a ${change} form for ${key}`);
  return form;
}

// What submitting it sends: every named field, checked boxes and radios only, textareas'
// contents; then whatever the person typed or ticked.
function posted(form: string, edit: (data: FormData) => void = () => {}): FormData {
  const data = new FormData();
  for (const m of form.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const name = attr(m[1]!, "name");
    const type = attr(m[1]!, "type") ?? "text";
    if (!name || ((type === "checkbox" || type === "radio") && !has(m[1]!, "checked"))) continue;
    data.append(name, attr(m[1]!, "value") ?? "");
  }
  for (const m of form.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attr(m[1]!, "name");
    if (name) data.append(name, decode(m[2]!));
  }
  edit(data);
  return data;
}

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) for (const v of [value].flat()) data.append(name, v);
  return data;
}

// =====================================================================================
// The parser the server action uses
// =====================================================================================

test("each change a form posts becomes the seam's input", () => {
  for (const action of ["on", "off", "remove", "restore", "use_new", "keep_mine"] as const) {
    assert.deepEqual(warthogSkillChange(form({ key: "using_warthog", change: action })), { key: "using_warthog", action });
  }
  assert.deepEqual(
    warthogSkillChange(form({ key: "using_warthog", change: "edit", useThisWhen: "when I need you", guidance: "Be brief." })),
    { key: "using_warthog", action: "edit", useThisWhen: "when I need you", guidance: "Be brief." },
  );
  assert.deepEqual(
    warthogSkillChange(form({ key: "life_admin_records", change: "scope", scope: "chosen", scopedAgentIds: ["a1", "a2"] })),
    { key: "life_admin_records", action: "scope", scope: "chosen", scopedAgentIds: ["a1", "a2"] },
  );
  assert.deepEqual(
    warthogSkillChange(form({ key: "life_admin_records", change: "scope", scope: "all", scopedAgentIds: ["a1"] })),
    { key: "life_admin_records", action: "scope", scope: "all" },
    "ticks don't count with All agents",
  );
  assert.deepEqual(
    warthogSkillChange(form({ key: "life_admin_records", change: "scope", scope: "everyone" })),
    { key: "life_admin_records", action: "scope", scope: "all" },
    "an unknown scope is All agents, as the people's own skills' forms read it",
  );
});

test("a form with no change, or one Warthog doesn't know, posts nothing", () => {
  assert.equal(warthogSkillChange(form({ key: "using_warthog" })), null);
  assert.equal(warthogSkillChange(form({ key: "using_warthog", change: "delete_everything" })), null);
});

test("each change has its own plain notice; an edit reads like any skill edit", () => {
  const notices = (["on", "off", "remove", "restore", "use_new", "keep_mine", "scope"] as const).map(warthogNotice);
  assert.equal(new Set(notices).size, notices.length, "a different notice for each");
  assert.equal(warthogNotice("edit"), "updated");
});

test("the page returns to the changed card only for one of Warthog's own keys", () => {
  assert.equal(warthogReturn("using_warthog"), "&skill=using_warthog");
  for (const key of ["", "not_a_skill", "using_warthog&notice=saved", "https://example.test"]) assert.equal(warthogReturn(key), "", key);
});

// =====================================================================================
// A posted form reaches changeWarthogSkill
// =====================================================================================

test("posting the rendered forms switches, edits, scopes, removes and restores one of Warthog's skills", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const user = await createUser(db, { email: `warthog-form-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
    const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "My Claude", platform: "claude" }, systemClock);
    const session: Session = { id: `sess-${user.id}`, userId: user.id, createdAt: new Date(), lastSeenAt: new Date(), steppedUpAt: null };
    const actions = createSkillsActions({ db, keyWrapper });
    const agents = [{ id: agent.id, displayName: agent.displayName, status: "connected" }];

    const page = async () => renderToStaticMarkup(<WarthogSkills skills={(await actions.load(session)).warthogSkills} agents={agents} />);
    const submit = async (key: string, change: string, edit?: (data: FormData) => void) => {
      const input = warthogSkillChange(posted(formFor(await page(), key, change), edit));
      assert.ok(input, `${change} posts a change`);
      const result = await actions.changeWarthogSkill(session, input);
      assert.deepEqual(result, { ok: true }, `${change} on ${key}`);
    };
    const view = async (key: string) => (await actions.load(session)).warthogSkills.find((skill) => skill.key === key)!;

    await submit("using_warthog", "off");
    assert.equal((await view("using_warthog")).state, "off");
    await submit("using_warthog", "on");
    assert.equal((await view("using_warthog")).state, "on");

    await submit("using_warthog", "edit", (data) => data.set("guidance", "Be brief with me."));
    const edited = await view("using_warthog");
    assert.equal(edited.guidance, "Be brief with me.");
    assert.equal(edited.useThisWhen, edited.warthogUseThisWhen, "the untouched line posts back as it was");
    assert.equal(edited.edited, true);

    await submit("using_warthog", "restore");
    assert.equal((await view("using_warthog")).edited, false, "Restore puts back Warthog's wording");

    await submit("life_admin_records", "scope", (data) => {
      data.set("scope", "chosen");
      data.append("scopedAgentIds", agent.id);
    });
    const scoped = await view("life_admin_records");
    assert.equal(scoped.scope, "chosen");
    assert.deepEqual(scoped.scopedAgentIds, [agent.id]);
    // The re-rendered form keeps the choice: posting it unchanged changes nothing.
    await submit("life_admin_records", "scope");
    assert.deepEqual((await view("life_admin_records")).scopedAgentIds, [agent.id]);

    await submit("life_admin_records", "remove");
    assert.equal((await view("life_admin_records")).state, "removed");
    await submit("life_admin_records", "restore");
    const restored = await view("life_admin_records");
    assert.equal(restored.state, "on");
    assert.equal(restored.scope, "all");
  } finally {
    await db.close();
  }
});
