// How the Activity screen organises the audit log (`./organise`): the founder asked for a
// timeline, a view by agent (click an agent to see its activity), a view by activity type and
// other helpful grouping — instead of one long thread. Pure: state, links and labels.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NONE,
  appliedFilters,
  breadcrumb,
  dayOf,
  filtersFor,
  quickLinks,
  readActivityState,
  timeOfDay,
  viewLinks,
  agentGroups,
  typeGroups,
} from "./organise";
import type { ActivityGroupSummary } from "@/server/activity/list";

const anyDate = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
const widen = (to: string) => `${to}T23:59:59.999Z`;
const AGENT = "0f6e3c1a-1111-4222-8333-944455556666";

test("unknown views, types and malformed ids are ignored rather than echoed", () => {
  const state = readActivityState({ view: "../settings", type: "nope", agent: "<script>", service: "a b", kind: "Tool Call", attention: "yes", via: "x" }, anyDate);
  assert.equal(state.view, "timeline");
  assert.equal(state.type, undefined);
  assert.equal(state.agent, undefined);
  assert.equal(state.service, undefined);
  assert.equal(state.kind, undefined);
  assert.equal(state.attention, undefined);
  assert.equal(state.via, undefined);
});

test("the state selects SQL filters, including no-agent and needs-attention", () => {
  const state = readActivityState({ agent: NONE, type: "change", attention: "1", to: "2026-11-12" }, anyDate);
  assert.deepEqual(filtersFor(state, widen), { noAgent: true, category: "change", attention: true, to: "2026-11-12T23:59:59.999Z" });
});

test("view tabs keep every filter, drop one-off parameters, and grouped views drop the page-only search", () => {
  const state = readActivityState({ agent: AGENT, q: "mail", before: "40", verify: "1" }, anyDate);
  const links = viewLinks(state);
  assert.deepEqual(links.map((link) => link.label), ["Timeline", "By agent", "By type", "By service"]);
  assert.equal(links[0]!.active, true);
  assert.equal(links[0]!.href, `/activity?agent=${AGENT}&q=mail`);
  assert.equal(links[1]!.href, `/activity?agent=${AGENT}&view=agents`);
  for (const link of links) {
    assert.doesNotMatch(link.href, /before=|verify=|entry=|notice=/);
  }
});

test("quick filters switch between all, needs attention and common types", () => {
  const links = quickLinks(readActivityState({ type: "read" }, anyDate));
  assert.deepEqual(links.map((link) => link.label), ["All activity", "Needs attention", "Reads", "Changes", "Approvals & releases", "Agent reports"]);
  assert.equal(links.find((link) => link.active)?.label, "Reads");
  assert.equal(links[0]!.href, "/activity");
  assert.equal(links[1]!.href, "/activity?attention=1");
});

test("each applied filter is a chip that removes only itself; clear-all keeps the view", () => {
  const state = readActivityState({ view: "types", agent: AGENT, type: "change", q: "x" }, anyDate);
  const { filters, clearHref } = appliedFilters(state, { agent: "Claude" });
  assert.deepEqual(filters.map((f) => f.label), ["Agent: Claude", "Type: Changes", "Search: “x”"]);
  assert.equal(filters[0]!.removeHref, "/activity?q=x&type=change&view=types");
  assert.equal(clearHref, "/activity?view=types");
});

test("a drill-down from a grouped view offers the way back, without its own group filter", () => {
  const state = readActivityState({ agent: AGENT, via: "agents", type: "read" }, anyDate);
  assert.deepEqual(breadcrumb(state), { label: "All agents", href: "/activity?type=read&view=agents" });
  const chip = appliedFilters(state, { agent: "Claude" }).filters[0]!;
  assert.equal(chip.removeHref, "/activity?type=read", "removing the agent also leaves the drill-down");
  assert.equal(breadcrumb(readActivityState({ agent: AGENT }, anyDate)), undefined);
});

test("days are headed Today / Yesterday / a date, in the account time zone", () => {
  const now = new Date("2026-11-12T03:00:00Z"); // 2pm in Sydney
  assert.deepEqual(dayOf("2026-11-11T22:00:00Z", "Australia/Sydney", now), { key: "2026-11-12", label: "Today" });
  assert.equal(dayOf("2026-11-11T10:00:00Z", "Australia/Sydney", now).label, "Yesterday");
  assert.equal(dayOf("2026-11-09T01:00:00Z", "Australia/Sydney", now).label, "Mon, 9 Nov");
  assert.match(dayOf("2025-11-09T01:00:00Z", "Australia/Sydney", now).label, /2025/);
  assert.equal(timeOfDay("2026-11-12T03:04:00Z", "Australia/Sydney"), "2:04 pm");
});

function summary(key: string | null, patch: Partial<ActivityGroupSummary> = {}): ActivityGroupSummary {
  return {
    key,
    total: 5,
    lastAt: "2026-11-12T01:00:00.000Z",
    byCategory: { read: 3, change: 2, approval: 0, report: 0, rejected: 0, access: 0, account: 0, other: 0 },
    byOutcome: { done: 4, waiting: 0, blocked: 1, failed: 0, other: 0 },
    disputed: 0,
    ...patch,
  };
}

test("agent groups drill into that agent's timeline, surface what needs attention and put no-agent last", () => {
  const rows = agentGroups(
    [summary(null), summary(AGENT)],
    () => ({ name: "Claude", platform: "Claude", exists: true }),
    readActivityState({}, anyDate),
    () => "Today, 12:00 pm",
  );
  assert.deepEqual(rows.map((row) => row.label), ["Claude", "Account and Warthog"]);
  const claude = rows[0]!;
  assert.equal(claude.href, `/activity?agent=${AGENT}&via=agents`);
  assert.deepEqual(claude.split.map((part) => [part.label, part.count]), [["Reads", 3], ["Changes", 2]]);
  assert.equal(claude.split[0]!.href, `/activity?agent=${AGENT}&type=read&via=agents`);
  assert.equal(claude.blocked, 1);
  assert.equal(claude.attentionHref, `/activity?agent=${AGENT}&attention=1&via=agents`);
  assert.equal(claude.manageHref, `/agents/${AGENT}?section=activity`);
  assert.equal(rows[1]!.href, "/activity?agent=none&via=agents");
  assert.equal(rows[1]!.manageHref, undefined);
});

test("two connections with the same name are told apart, never merged", () => {
  const other = "28e3dfa1-7fc1-47da-8d0c-583cf7794c38";
  const rows = agentGroups(
    [summary(AGENT), summary(other)],
    (id) => ({ name: "Claude", exists: true, connectedOn: id === AGENT ? "3 Nov 2026" : "10 Nov 2026", disconnected: id === AGENT }),
    readActivityState({}, anyDate),
    () => "",
  );
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.detail ?? "", /Disconnected · connected 3 Nov 2026/);
  assert.match(rows[1]!.detail ?? "", /connected 10 Nov 2026/);
});

test("the type view lists every type in a fixed order; an empty type has no dead link", () => {
  const rows = typeGroups(
    [summary("read", { total: 3 })],
    [summary(AGENT)],
    () => "Claude",
    readActivityState({}, anyDate),
    () => "",
  );
  assert.deepEqual(rows.map((row) => row.id).slice(0, 3), ["type-read", "type-change", "type-approval"]);
  assert.equal(rows[0]!.href, "/activity?type=read&via=types");
  assert.equal(rows[0]!.top, "Claude 3");
  assert.equal(rows[1]!.total, 0);
  assert.equal(rows[1]!.href, undefined);
});

// UI/UX pass (content-47): the page states its times in the account's zone, so a calendar-day
// filter means that day there, not in UTC.
test("calendar-day filters cover the whole day in the account's time zone", async () => {
  const { dayStartIn, dayEndIn } = await import("./organise");
  assert.equal(dayStartIn("2026-11-12", "Australia/Sydney"), "2026-11-11T13:00:00.000Z", "midnight in Sydney (summer time, UTC+11)");
  assert.equal(dayEndIn("2026-11-12", "Australia/Sydney"), "2026-11-12T12:59:59.999Z");
  assert.equal(dayStartIn("2026-06-01", "Australia/Sydney"), "2026-05-31T14:00:00.000Z", "winter time, UTC+10");
  assert.equal(dayStartIn("2026-04-05", "Australia/Sydney"), "2026-04-04T13:00:00.000Z", "the day daylight saving ends starts at its local midnight");
  assert.equal(dayEndIn("2026-04-05", "Australia/Sydney"), "2026-04-05T13:59:59.999Z", "and that day is 25 hours long");
  assert.equal(dayStartIn("2026-11-12", "UTC"), "2026-11-12T00:00:00.000Z");
  assert.equal(dayEndIn("2026-11-12T05:00:00Z", "UTC"), "2026-11-12T05:00:00Z", "a date-time is left exactly as given");
});

test("applied date chips and the counts caption name the day without a UTC suffix", async () => {
  const { countsCaption } = await import("./organise");
  const state = readActivityState({ from: "2026-03-01", to: "2026-03-31", kind: "tool_call", outcome: "pending_approval" }, anyDate);
  const labels = appliedFilters(state, {}).filters.map((f) => f.label);
  assert.deepEqual(labels, ["Event: Agent request", "Outcome: Waiting for you", "From 1 Mar 2026", "To 31 Mar 2026"]);
  assert.equal(countsCaption(state).startsWith("Counts cover 1 Mar 2026 to 31 Mar 2026, within the filters shown."), true);
  assert.ok(!/UTC|intent record/.test(countsCaption(state)));
});

test("an agent row names its platform in words, and leaves out a placeholder", () => {
  const detail = (facts: Parameters<typeof agentGroups>[1]) => agentGroups([summary(AGENT)], facts, readActivityState({}, anyDate), () => "")[0]!.detail;
  assert.equal(detail(() => ({ name: "Dev console", platform: "dev-console", platformName: "Developer console", exists: true })), "Developer console");
  assert.equal(detail(() => ({ name: "Helper", platform: "Other", platformName: null, exists: true })), undefined);
  assert.equal(detail(() => ({ name: "Claude", platform: "Claude", platformName: "Claude", exists: true })), undefined, "a platform that repeats the name adds nothing");
});

test("one agent conversation is a filter: a run id selects it, a chip names it, anything else is ignored", () => {
  const RUN = "5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e";
  const state = readActivityState({ run: RUN.toUpperCase(), agent: AGENT }, anyDate);
  assert.equal(state.run, RUN, "a run id is read case-insensitively");
  assert.deepEqual(filtersFor(state, widen), { agentId: AGENT, runId: RUN });
  const { filters } = appliedFilters(state, { agent: "Claude", run: "Fixing the website tests" });
  const chip = filters.find((filter) => filter.label === "Conversation: Fixing the website tests");
  assert.ok(chip, "the chip names the conversation as the agent described it");
  assert.doesNotMatch(chip!.removeHref, /run=/, "removing it drops only the conversation");
  assert.match(chip!.removeHref, /agent=/);
  assert.equal(appliedFilters(readActivityState({ run: RUN }, anyDate), {}).filters[0]!.label, "Conversation: Untitled conversation");
  for (const bad of ["<script>", "not-a-run", `${RUN}x`, "1; DROP TABLE"]) {
    assert.equal(readActivityState({ run: bad }, anyDate).run, undefined, bad);
  }
});
