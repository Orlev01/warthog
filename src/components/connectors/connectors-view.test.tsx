// E09-S16 — Connectors view component (src/components/connectors/connectors-view.tsx).
//
// RED-first: src/components/connectors/connectors-view.tsx does NOT exist yet, so
// importing `./connectors-view` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do NOT
// implement anything to make these pass.
//
// WHY this component exists (brief "Connector hub" — a primary-journey surface;
// design §7; CLAUDE.md vocabulary — a *connector* is a catalogue entry, a *connection*
// is a person's connected service). The Connectors screen has two halves:
//   • the CATALOGUE, searchable and browsable BY CATEGORY, with a "Connect" affordance
//     on each entry, "Early access — ask to join" on a gated Google entry, and a
//     "Request a connector" affordance on a MISS (nothing matched the search); and
//   • the CONNECTED-SERVICES list, each connection showing its status, the account
//     connected, the date connected, the tools it offers (each marked "reads" or
//     "makes changes"), which agents may use it, and a one-click Disconnect.
//
// THIS component is the pure, prop-driven VIEW — exactly like AgentListView /
// DashboardView / ActivityView: it renders the screen from already-formatted props so
// it can be pinned without a browser, a session or any server plumbing. The loader (a
// later task) reads/decrypts/formats and feeds it: dates arrive as pre-formatted
// LABELS; the per-person Google gate decision arrives as each catalogue item's `gate`
// ("connect" | "ask_to_join" — the kind of GoogleGateDecision); connection `status` is
// the shared StatusKey union the <Status> primitive renders; and the Connect /
// Disconnect / Request controls are BOUND to the server actions the page passes
// (exactly as AgentListView binds Disconnect). The view reaches for no clock, locale,
// DB or config and decides nothing.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the view RENDERS for the props it is given (the
//     plain-words copy a person reads, the category grouping, the marked tools, the
//     accessible controls, the bound action carrying the right id) — never the source
//     text of connectors-view.tsx. A behaviour-preserving refactor (different wrappers,
//     reworded-but-still-plain copy, extra classes, a different icon, composing a UI
//     primitive) stays green.
//   * They render with `react-dom/server` (no DOM/jsdom — React component / E2E
//     testing is a per-job ADR) and read the emitted markup, mirroring every other
//     component render test in this repo (agent-list-view, dashboard-view, …).
//   * Absence/uniqueness checks ("no 'null'", "no Connect on a gated entry", "the
//     disconnect form carries THIS connection's id", "a read tool is not marked as
//     making changes") are scoped to the exact unit under test — a single entry or a
//     single connection rendered ALONE, or one control's own <form> — never a whole-
//     output scan, because the same word/id can legitimately appear elsewhere.
//
// The prop shapes below are the cross-task contract this task introduces (documented
// here exactly as the sibling view tests document theirs); the loader adapts the
// E09-S15 page-data reads (`browseCatalogue` groups + `listConnectionsForPage`) plus
// the E09-S13 Google gate into these view props. The view must export a `ConnectorsView`
// whose props accept the objects these tests construct.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectorsView } from "./connectors-view";

// --- the prop shapes this task introduces (described here as the contract) ------

// The connection state the UI <Status> primitive knows (one source of truth with the
// agents list / dashboard): "connected" | "needs-reconnect" | "error" | "pending".
type StatusKey = "connected" | "needs-reconnect" | "error" | "pending";

// One catalogue entry as the view renders it. `connectable` is the index's own
// connectability truth (E09-S15). `gate` is the per-person decision (E09-S13): "connect"
// offers a Connect control; "ask_to_join" is a gated Google entry — the view shows
// "Early access — ask to join" instead of Connect.
type CatalogueItem = {
  id: string; // the connector id the Connect / ask-to-join action consumes
  name: string; // display name, e.g. "Gmail"
  connectable: boolean;
  gate: "connect" | "ask_to_join";
};

// The catalogue entries of one category, grouped so the view can render a section per
// category (brief "searchable and browsable by category").
type CatalogueGroup = {
  category: string; // e.g. "Email"
  items: readonly CatalogueItem[];
};

// One tool a connection offers, marked: false = a read, true = makes a change (brief
// 'each marked as "reads" or "makes changes"').
type ToolItem = {
  name: string;
  makesChange: boolean;
};

// One of the person's connected services as the view lists it (never credentials):
// the connector display name, the account connected, the pre-formatted connected-date
// label, the status, the marked tools, and the names of the agents that may use it.
type ConnectionItem = {
  id: string; // the connection id the Disconnect action consumes
  name: string; // the connector's display name
  accountLabel: string; // the account connected
  status: StatusKey;
  connectedAt: string; // pre-formatted connected-date label (never a raw Date)
  tools: readonly ToolItem[];
  agents: readonly string[]; // names of agents that may use this connection
};

type ConnectorsViewProps = {
  groups: readonly CatalogueGroup[]; // catalogue browse, grouped by category
  connections: readonly ConnectionItem[]; // the person's connected services (all statuses)
  query: string | null; // the search term echoed back (prefill); null = no search
  canRequest: boolean; // a MISS → surface "Request a connector"
  // Controls BOUND to server actions the page passes. OPTIONAL: when an action is NOT
  // supplied its control renders DISABLED with a one-line reason rather than a live
  // button over a missing action (constitution: no dead controls — disable it and say
  // why), exactly as AgentListView treats its Disconnect action.
  connectAction?: (formData: FormData) => void | Promise<void>;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
  requestAction?: (formData: FormData) => void | Promise<void>;
};

// The exact funnel copy a gated Google entry shows (E09-S13's ASK_TO_JOIN_LABEL; UI
// copy — do not drift; the "—" is an em dash, U+2014).
const EARLY_ACCESS_LABEL = "Early access — ask to join";
// The exact miss affordance copy (brief "Request a connector").
const REQUEST_LABEL = "Request a connector";

// --- fixtures -------------------------------------------------------------------
//
// Hex-free content (so the raw-hex scan can only catch a hard-coded colour). Marker
// strings are DIGIT-FREE and distinct, and deliberately contain none of the words the
// tool-marking / status / absence assertions look for ("read", "change", "makes",
// "null", "connect"), so a field-presence assertion can only be satisfied by the field
// it targets.

const GMAIL_GATED: CatalogueItem = {
  id: "google-gmail",
  name: "Gmail",
  connectable: true, // connectable, yet gated for this person → ask-to-join wins
  gate: "ask_to_join",
};
const FASTMAIL_CONNECT: CatalogueItem = {
  id: "fastmail",
  name: "Fastmail",
  connectable: true,
  gate: "connect",
};
const CALENDLY_CONNECT: CatalogueItem = {
  id: "calendly",
  name: "Calendly",
  connectable: true,
  gate: "connect",
};

const GROUP_EMAIL: CatalogueGroup = {
  category: "Email",
  items: [GMAIL_GATED, FASTMAIL_CONNECT],
};
const GROUP_CALENDAR: CatalogueGroup = {
  category: "Calendar",
  items: [CALENDLY_CONNECT],
};

const CONN_A: ConnectionItem = {
  id: "conn-maple",
  name: "Fastmail",
  accountLabel: "robin mailbox",
  status: "connected",
  connectedAt: "the first of autumn",
  tools: [
    { name: "fetch the inbox", makesChange: false },
    { name: "post an update", makesChange: true },
  ],
  agents: ["Research buddy", "Inbox helper"],
};
const CONN_B: ConnectionItem = {
  id: "conn-birch",
  name: "Calendly",
  accountLabel: "shared diary",
  status: "needs-reconnect",
  connectedAt: "around midwinter",
  tools: [], // no tools
  agents: [], // no agents yet
};
const CONN_C: ConnectionItem = {
  id: "conn-cedar",
  name: "Dropbox",
  accountLabel: "work drive",
  status: "error",
  connectedAt: "last Tuesday",
  tools: [{ name: "browse files", makesChange: false }],
  agents: ["Travel planner"],
};

// Single-tool connections, so the "reads vs makes changes" marking can be pinned on one
// tool with the whole (minimal) card scoped to that one marking. Each carries one agent
// so no empty-agents copy appears to pollute the scoped absence checks.
const CONN_READ_ONLY: ConnectionItem = {
  id: "conn-read",
  name: "Fastmail",
  accountLabel: "mailbox owner",
  status: "connected",
  connectedAt: "early spring",
  tools: [{ name: "fetch the inbox", makesChange: false }],
  agents: ["pilot"],
};
const CONN_CHANGE_ONLY: ConnectionItem = {
  id: "conn-change",
  name: "Dropbox",
  accountLabel: "file store",
  status: "connected",
  connectedAt: "late autumn",
  tools: [{ name: "post an update", makesChange: true }],
  agents: ["pilot"],
};

// A stand-in server action: a bound action is what makes a control LIVE. A test probes
// a disabled path by overriding the relevant action to `undefined`.
const noopAction = async (_formData: FormData): Promise<void> => {};

// By default every control is bound (the page's live wiring), so the control tests
// exercise live controls; a test overrides one to probe its disabled path.
function base(overrides: Partial<ConnectorsViewProps> = {}): ConnectorsViewProps {
  return {
    groups: [GROUP_EMAIL, GROUP_CALENDAR],
    connections: [CONN_A, CONN_B, CONN_C],
    query: null,
    canRequest: false,
    connectAction: noopAction,
    disconnectAction: noopAction,
    requestAction: noopAction,
    ...overrides,
  };
}

// --- tiny markup helpers (no DOM), mirrored from the sibling component tests -----

function render(props: ConnectorsViewProps): string {
  return renderToStaticMarkup(<ConnectorsView {...props} />);
}

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

// Visible text with tags stripped and entities decoded — the words a sighted reader
// sees (an <svg> icon contributes none). <script>/<style> BLOCKS are dropped whole: a
// bound server-action form makes React inject a progressive-enhancement submit script
// whose JS text is NOT visible copy and must never leak into a visible-text / no-"null"
// / reason-surface assertion.
function visibleText(markup: string): string {
  const withoutScripts = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decode(withoutScripts.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}

// The accessible name of a control: its visible text PLUS any aria-label / title that
// voices it (so an icon-only control named by aria-label still counts).
function controlFace(el: El): string {
  const parts = [visibleText(el.inner)];
  const al = attr(el.attrs, "aria-label");
  if (al) parts.push(decode(al));
  const ti = attr(el.attrs, "title");
  if (ti) parts.push(decode(ti));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isDisabled(el: El): boolean {
  return /\bdisabled\b/i.test(el.attrs);
}

// Every <button> whose accessible name matches `re` (disabled ones included).
function buttonsMatching(markup: string, re: RegExp): El[] {
  return findAll(markup, "button").filter((b) => re.test(controlFace(b)));
}

function inputAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push(m[1]!);
  return out;
}

// Does `re` appear in the visible text within `window` chars of the first occurrence of
// `needle`? Proves two things render TOGETHER (a tool and its marking; an agent and the
// "agents" label) without pinning exact layout.
function nearInText(markup: string, needle: string, re: RegExp, window = 80): boolean {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  const lo = Math.max(0, i - window);
  const hi = Math.min(vt.length, i + needle.length + window);
  return re.test(vt.slice(lo, hi));
}

// --- form-scoped helpers for the bound controls ----------------------------------
//
// Forms don't nest, so each <form>…</form> pairs with its own close tag. These scope an
// assertion to ONE control's own form — never the whole screen.

function formsForControl(markup: string, re: RegExp): El[] {
  return findAll(markup, "form").filter((f) =>
    findAll(f.inner, "button").some((b) => re.test(controlFace(b))),
  );
}

// React encodes a FUNCTION form action (a bound server action) as a `javascript:`
// progressive-enhancement placeholder in server-rendered markup; a bare form carries no
// such action. So "this form is bound to a server action" is observable as its action
// scheme — behaviour, not source text. (Same probe as agent-list-view.test.tsx.)
function isBoundToAction(form: El): boolean {
  const action = attr(form.attrs, "action");
  return action !== null && /^javascript:/i.test(action);
}

// Whether any field (hidden or otherwise) inside `form` carries the exact value `value`
// — e.g. the connector/connection id the bound action consumes. Robust to the field's
// NAME, pinning only the behaviour that the form identifies WHICH entry it acts on.
function formCarriesValue(form: El, value: string): boolean {
  return inputAttrs(form.inner).some((a) => attr(a, "value") === value);
}

// The "say-why" surface: visible text PLUS every title / aria-label (an accessible
// reason may ride on either). A disabled control that says why carries MORE of this than
// the same control rendered live.
function reasonSurface(markup: string): string {
  const parts = [visibleText(markup)];
  for (const m of markup.matchAll(/(?:title|aria-label)="([^"]*)"/gi)) parts.push(decode(m[1]!));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// The visible text within `window` chars either side of the first occurrence of
// `needle` — a slice scoped to one tool's own row, so a marking assertion (and the
// scoped absence of the OPPOSITE marking) targets that tool alone and never a distant
// legend line that names BOTH markings.
function sliceAround(markup: string, needle: string, window = 48): string {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return "";
  return vt.slice(Math.max(0, i - window), Math.min(vt.length, i + needle.length + window));
}

// A search field: an <input> that is a search control (type=search, a query-ish name, or
// a search placeholder / aria-label). Returns the matching inputs' attr strings.
function searchInputs(markup: string): string[] {
  return inputAttrs(markup).filter((a) => {
    const type = attr(a, "type");
    const name = attr(a, "name") ?? "";
    const ph = attr(a, "placeholder") ?? "";
    const al = attr(a, "aria-label") ?? "";
    return (
      (type !== null && /search/i.test(type)) ||
      /^(q|query|search)$/i.test(name) ||
      /search/i.test(ph) ||
      /search/i.test(al)
    );
  });
}

// ================================================================================
// AC1 — the catalogue, searchable and browsable BY CATEGORY.
// ================================================================================

test("renders the catalogue entries grouped under their category", () => {
  // One group alone, so the category label and its entries can only be this group's and
  // cannot bleed into another category's section.
  const markup = render(base({ groups: [GROUP_EMAIL], connections: [] }));
  const text = visibleText(markup);
  assert.ok(text.includes("Email"), `the category "Email" must head its section; text="${text}"`);
  assert.ok(text.includes("Gmail"), `the "Gmail" entry must render under its category; text="${text}"`);
  assert.ok(
    text.includes("Fastmail"),
    `the "Fastmail" entry must render under its category; text="${text}"`,
  );
  assert.ok(
    nearInText(markup, "Email", /Gmail|Fastmail/, 220),
    `the Email entries must render under the Email category heading; text="${text}"`,
  );
});

test("renders every category's section and entries", () => {
  const text = visibleText(render(base({ connections: [] })));
  for (const group of [GROUP_EMAIL, GROUP_CALENDAR]) {
    assert.ok(
      text.includes(group.category),
      `the category "${group.category}" must head a section; text="${text}"`,
    );
    for (const item of group.items) {
      assert.ok(
        text.includes(item.name),
        `the entry "${item.name}" must render; text="${text}"`,
      );
    }
  }
});

test("renders the catalogue from the groups given, not a fixed list", () => {
  const textA = visibleText(render(base({ groups: [GROUP_EMAIL], connections: [] })));
  const textB = visibleText(render(base({ groups: [GROUP_CALENDAR], connections: [] })));
  assert.ok(textA.includes("Fastmail"), "group A shows its Email entry");
  assert.ok(!textA.includes("Calendly"), "group A must not show group B's entry");
  assert.ok(textB.includes("Calendly"), "group B shows its Calendar entry");
  assert.ok(!textB.includes("Fastmail"), "group B must not show group A's entry");
});

test("renders a search field inside a form", () => {
  const markup = render(base({ connections: [] }));
  assert.ok(
    searchInputs(markup).length >= 1,
    `the catalogue must offer a search field; markup="${markup}"`,
  );
  const searchForms = findAll(markup, "form").filter((f) => searchInputs(f.inner).length > 0);
  assert.ok(searchForms.length >= 1, "the search field must live in a form that can submit the search");
});

test("prefills the search field with the current query", () => {
  const markup = render(base({ query: "spreadsheet" }));
  const prefilled = searchInputs(markup).some((a) => attr(a, "value") === "spreadsheet");
  assert.ok(
    prefilled,
    `the search field must echo the current query "spreadsheet" so a search survives reload; markup="${markup}"`,
  );
});

// ================================================================================
// AC1 — each connected service's status, account, date, tools (reads vs makes-changes)
// and which agents may use it.
// ================================================================================

test("renders a connection's connector name, account and connected date", () => {
  // Rendered alone so each distinctive label can only come from this connection.
  const text = visibleText(render(base({ groups: [], connections: [CONN_A] })));
  assert.ok(text.includes(CONN_A.name), `the connector name "${CONN_A.name}" must show; text="${text}"`);
  assert.ok(
    text.includes(CONN_A.accountLabel),
    `the account connected "${CONN_A.accountLabel}" must show; text="${text}"`,
  );
  assert.ok(
    text.includes(CONN_A.connectedAt),
    `the connected-date label "${CONN_A.connectedAt}" must show; text="${text}"`,
  );
});

test("renders a connection's status in words (not colour alone)", () => {
  // Rendered alone so the status word can only come from that connection's status. These
  // StatusKey labels are the shared <Status> vocabulary ("Reconnect needed", "Error").
  const reconnect = visibleText(render(base({ groups: [], connections: [CONN_B] }))); // needs-reconnect
  assert.match(
    reconnect,
    /reconnect/i,
    `a needs-reconnect connection must show its status in words; text="${reconnect}"`,
  );
  const errored = visibleText(render(base({ groups: [], connections: [CONN_C] }))); // error
  assert.match(
    errored,
    /error|problem|attention/i,
    `an errored connection must show its status in words; text="${errored}"`,
  );
});

test("marks a read tool as 'reads' (not as making changes)", () => {
  // A single-read-tool connection rendered alone: the only tool marking present is this
  // read, so the scoped absence check ("not marked as making changes") targets it alone.
  const markup = render(base({ groups: [], connections: [CONN_READ_ONLY] }));
  assert.ok(visibleText(markup).includes("fetch the inbox"), `the tool name must show; text="${visibleText(markup)}"`);
  const row = sliceAround(markup, "fetch the inbox");
  assert.match(row, /\breads?\b/i, `a read tool must be marked "reads"; row="${row}"`);
  assert.ok(
    !/makes\s+(?:a\s+)?changes?|\bchanges?\b/i.test(row),
    `a read tool must not be marked as making changes; row="${row}"`,
  );
});

test("marks a makes-changes tool as 'makes changes' (not as a read)", () => {
  // A single-change-tool connection rendered alone: the only tool marking present is this
  // change, so the scoped absence check ("not marked reads") targets it alone.
  const markup = render(base({ groups: [], connections: [CONN_CHANGE_ONLY] }));
  assert.ok(visibleText(markup).includes("post an update"), `the tool name must show; text="${visibleText(markup)}"`);
  const row = sliceAround(markup, "post an update");
  assert.match(
    row,
    /makes\s+(?:a\s+)?changes?|\bchanges?\b/i,
    `a makes-changes tool must be marked "makes changes"; row="${row}"`,
  );
  assert.ok(!/\breads?\b/i.test(row), `a makes-changes tool must not be marked as a read; row="${row}"`);
});

test("renders which agents may use a connection", () => {
  // Rendered alone so the agent names can only come from this connection.
  const markup = render(base({ groups: [], connections: [CONN_A] }));
  const text = visibleText(markup);
  for (const agentName of CONN_A.agents) {
    assert.ok(
      text.includes(agentName),
      `the agent "${agentName}" that may use this connection must be shown; text="${text}"`,
    );
  }
  assert.ok(
    nearInText(markup, CONN_A.agents[0]!, /agent|used by/i, 100),
    `the agents that may use a connection must read AS the agents that use it; text="${text}"`,
  );
});

test("a connection with no tools and no agents renders plainly (never the word null)", () => {
  // CONN_B has empty tools and empty agents. Rendered alone, so the absence check is
  // scoped to this one connection.
  const markup = render(base({ groups: [], connections: [CONN_B] }));
  const text = visibleText(markup);
  assert.ok(text.length >= 3, `the connection must still render something; text="${text}"`);
  assert.ok(
    !/\bnull\b/i.test(text),
    `empty tools/agents must not render the literal "null"; text="${text}"`,
  );
});

// ================================================================================
// AC2 — "Early access — ask to join" on a gated Google entry; "Request a connector" on
// a miss.
// ================================================================================

test("shows 'Early access — ask to join' on a gated Google entry, not a plain Connect", () => {
  // The gated entry alone (no connections), so the funnel copy and the absence of a live
  // Connect are scoped to this one entry.
  const markup = render(base({ groups: [{ category: "Email", items: [GMAIL_GATED] }], connections: [] }));
  const text = visibleText(markup);
  assert.ok(
    text.includes(EARLY_ACCESS_LABEL),
    `a gated Google entry must show the exact "${EARLY_ACCESS_LABEL}" funnel copy; text="${text}"`,
  );
  assert.equal(
    buttonsMatching(markup, /\bconnect\b/i).length,
    0,
    "a gated entry must NOT offer a plain Connect control — the ask-to-join funnel replaces it",
  );
});

test("a non-gated connectable entry offers Connect, not the early-access funnel", () => {
  // A single connect-gate entry alone, so the presence of Connect and the absence of the
  // funnel copy are scoped to this one entry.
  const markup = render(base({ groups: [{ category: "Email", items: [FASTMAIL_CONNECT] }], connections: [] }));
  assert.ok(
    buttonsMatching(markup, /\bconnect\b/i).length >= 1,
    "a connectable, non-gated entry must offer a Connect control",
  );
  assert.ok(
    !visibleText(markup).includes(EARLY_ACCESS_LABEL),
    `a non-gated entry must not show the "${EARLY_ACCESS_LABEL}" funnel; text="${visibleText(markup)}"`,
  );
});

test("shows 'Request a connector' on a miss, with a field to name the service", () => {
  // A miss: nothing matched the search (no groups), canRequest true, the search term
  // echoed back so the request form can prefill it.
  const markup = render(base({ groups: [], connections: [], canRequest: true, query: "time machine" }));
  const text = visibleText(markup);
  assert.ok(
    text.includes(REQUEST_LABEL),
    `a miss must offer "${REQUEST_LABEL}"; text="${text}"`,
  );
  const reqForms = formsForControl(markup, /request/i);
  assert.ok(reqForms.length >= 1, "the Request-a-connector control must live in a form");
  assert.ok(
    reqForms.some((f) => formCarriesValue(f, "time machine")),
    `the Request form must prefill the named service with the echoed query "time machine"; markup="${markup}"`,
  );
});

// ================================================================================
// AC — Connect / Disconnect / Request controls bind to the server actions, carrying the
// right id; and render DISABLED with a reason when their action is not configured.
// ================================================================================

test("binds Connect to connectAction, carrying THIS entry's connector id", () => {
  // The one connect entry alone, so the single Connect form can only be this entry's.
  const dispatched = async (_formData: FormData): Promise<void> => {};
  const markup = render(
    base({ groups: [{ category: "Email", items: [FASTMAIL_CONNECT] }], connections: [], connectAction: dispatched }),
  );
  const forms = formsForControl(markup, /\bconnect\b/i);
  assert.equal(forms.length, 1, "exactly one Connect form for the single entry");
  const form = forms[0]!;
  assert.ok(
    isBoundToAction(form),
    "the Connect form is BOUND to connectAction (a form action), not a dead button",
  );
  assert.ok(
    formCarriesValue(form, FASTMAIL_CONNECT.id),
    `the Connect form must carry the connector id "${FASTMAIL_CONNECT.id}" the action consumes`,
  );
});

test("Connect renders disabled with a reason when no connectAction is configured", () => {
  const withAction = render(
    base({ groups: [{ category: "Email", items: [FASTMAIL_CONNECT] }], connections: [], connectAction: async () => {} }),
  );
  const noAction = render(
    base({ groups: [{ category: "Email", items: [FASTMAIL_CONNECT] }], connections: [], connectAction: undefined }),
  );
  const buttons = buttonsMatching(noAction, /\bconnect\b/i);
  assert.ok(buttons.length >= 1, "the entry still surfaces a Connect affordance");
  assert.ok(buttons.every(isDisabled), "with no connectAction every Connect control is DISABLED");
  assert.equal(
    formsForControl(noAction, /\bconnect\b/i).filter(isBoundToAction).length,
    0,
    "the disabled Connect is not a bound live server-action form",
  );
  assert.ok(
    reasonSurface(noAction).length > reasonSurface(withAction).length,
    "the disabled Connect says WHY it is unavailable — a one-line reason the live control does not carry",
  );
});

test("binds Disconnect to disconnectAction, carrying THIS connection's id", () => {
  // One connection alone, so the single Disconnect form can only be this connection's.
  const dispatched = async (_formData: FormData): Promise<void> => {};
  const markup = render(base({ groups: [], connections: [CONN_A], disconnectAction: dispatched }));
  const forms = formsForControl(markup, /disconnect/i);
  assert.equal(forms.length, 1, "exactly one Disconnect form for the single connection");
  const form = forms[0]!;
  assert.ok(
    isBoundToAction(form),
    "the Disconnect form is BOUND to disconnectAction (a form action), not a dead button",
  );
  assert.ok(
    formCarriesValue(form, CONN_A.id),
    `the Disconnect form must carry the connection id "${CONN_A.id}" so it disconnects the right service`,
  );
});

test("Disconnect renders disabled with a reason when no disconnectAction is configured", () => {
  const withAction = render(base({ groups: [], connections: [CONN_A], disconnectAction: async () => {} }));
  const noAction = render(base({ groups: [], connections: [CONN_A], disconnectAction: undefined }));
  const buttons = buttonsMatching(noAction, /disconnect/i);
  assert.ok(buttons.length >= 1, "the connection still surfaces a Disconnect affordance");
  assert.ok(buttons.every(isDisabled), "with no disconnectAction every Disconnect control is DISABLED");
  assert.equal(
    formsForControl(noAction, /disconnect/i).filter(isBoundToAction).length,
    0,
    "the disabled Disconnect is not a bound live server-action form",
  );
  assert.ok(
    reasonSurface(noAction).length > reasonSurface(withAction).length,
    "the disabled Disconnect says WHY it is unavailable",
  );
});

test("binds the ask-to-join control to requestAction, carrying the gated connector's id", () => {
  // The gated entry alone, so the single ask-to-join form can only be this entry's.
  const dispatched = async (_formData: FormData): Promise<void> => {};
  const markup = render(
    base({ groups: [{ category: "Email", items: [GMAIL_GATED] }], connections: [], requestAction: dispatched }),
  );
  const forms = formsForControl(markup, /ask to join|early access/i);
  assert.equal(forms.length, 1, "exactly one ask-to-join form for the single gated entry");
  const form = forms[0]!;
  assert.ok(
    isBoundToAction(form),
    "the ask-to-join control is BOUND to requestAction (it files a connector request), not a dead button",
  );
  assert.ok(
    formCarriesValue(form, GMAIL_GATED.id),
    `the ask-to-join form must carry the gated connector id "${GMAIL_GATED.id}" the request names`,
  );
});

test("the Request / ask-to-join affordance renders disabled with a reason when no requestAction is configured", () => {
  // A miss: with requestAction the Request control is live; without it, it is DISABLED and
  // SAYS WHY (constitution: disable the control and say why).
  const missProps = { groups: [], connections: [], canRequest: true, query: "time machine" } as const;
  const withAction = render(base({ ...missProps, requestAction: async () => {} }));
  const noAction = render(base({ ...missProps, requestAction: undefined }));
  const buttons = buttonsMatching(noAction, /request/i);
  assert.ok(buttons.length >= 1, "the miss still surfaces a Request affordance");
  assert.ok(buttons.every(isDisabled), "with no requestAction every Request control is DISABLED");
  assert.equal(
    formsForControl(noAction, /request/i).filter(isBoundToAction).length,
    0,
    "the disabled Request is not a bound live server-action form",
  );
  assert.ok(
    reasonSurface(noAction).length > reasonSurface(withAction).length,
    "the disabled Request says WHY it is unavailable",
  );
});

// ================================================================================
// Empty / robustness states.
// ================================================================================

test("an empty connected-services list renders no Disconnect controls", () => {
  const markup = render(base({ connections: [] }));
  assert.equal(
    buttonsMatching(markup, /disconnect/i).length,
    0,
    "no Disconnect controls when there are no connections",
  );
  // The catalogue half still renders.
  assert.ok(visibleText(markup).includes("Fastmail"), "the catalogue still renders with no connections");
});

test("renders the connections from the list given, not a fixed list", () => {
  const textA = visibleText(render(base({ groups: [], connections: [CONN_A] })));
  const textC = visibleText(render(base({ groups: [], connections: [CONN_C] })));
  assert.ok(textA.includes("robin mailbox"), "list A shows A's account");
  assert.ok(!textA.includes("work drive"), "list A must not show C's account");
  assert.ok(textC.includes("work drive"), "list C shows C's account");
  assert.ok(!textC.includes("robin mailbox"), "list C must not show A's account");
});

test("renders a fully empty screen without crashing", () => {
  let markup: string;
  try {
    markup = render(base({ groups: [], connections: [], canRequest: false, query: null }));
  } catch (err) {
    assert.fail(
      "ConnectorsView must render empty props, not crash: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(visibleText(markup).length >= 3, `the empty screen must say something; text="${visibleText(markup)}"`);
});

// ================================================================================
// AC2 — colour comes from design tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour (every state)", () => {
  const states: ConnectorsViewProps[] = [
    base(),
    base({ connections: [] }),
    base({ groups: [], connections: [], canRequest: true, query: "time machine" }),
    base({ connectAction: undefined, disconnectAction: undefined, requestAction: undefined }),
    base({ groups: [{ category: "Email", items: [GMAIL_GATED] }], connections: [] }),
  ];
  for (const props of states) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the ConnectorsView markup, got: ${markup}`,
    );
  }
});
