// Read-side protection — the check every connector result passes before an agent reads it
// (docs/adr/read-side-protection.md; design §7 "Connector engine").
//
// The pipeline hands each executed connector result here (live calls, approved holds via
// check_approval and the inbox, provider tools). Gmail and Outlook messages get a checked
// view (readable text, numbered links, attachment names, sign-in mail stubbed); every other
// result gets the default check (hidden characters removed, sign-in links, sign-in codes and
// card numbers hidden, pre-authenticated download links dropped) with its shape kept. The
// numeric `status` envelope is always kept, so Undo and the evidence readers still work.
//
// Every path checks at the person's level (amendment 24 November 2026), which the pipeline puts
// on the call (`call.readLevel`, server-owned): "private" also hides identifying numbers,
// "open" hides nothing and stubs no sign-in email (hidden characters are still removed, the
// notice is still first, and the "recently read" window still opens). The evidence names a
// level other than the default.
//
// Never throws: a result Warthog cannot check is not shown (a read) or is reported done
// without the service's reply (a change — so the agent never retries a change that happened).
// Deterministic code only (brief no-ai-model-calls); counts only in the evidence, never
// content.

import { cleanJson, type JsonCleanCounts } from "../../domain/content/json-clean";
import { gmailMessageView, type MailView } from "../../domain/content/gmail-message";
import { MAIL_CONNECTOR_IDS } from "../../domain/content/mail-connectors";
import { outlookPaging } from "../../domain/content/merge-mail";
import { outlookMessageView } from "../../domain/content/outlook-message";
import { anythingHidden, cleanText, type CleanOptions, type FilterCounts } from "../../domain/content/text-filters";
import { DEFAULT_READ_LEVEL, type ReadLevel } from "../../domain/content/read-levels";
import { untrustedNotice, type ContentKind } from "../../domain/content/untrusted";
import type { AgentCall } from "../mcp/pipeline";
import type { ReadSource } from "../db/read-exposures";

/** How a checked result was handled — the `agent.read_guard` metric's outcome label. */
export type GuardOutcome = "shown" | "masked" | "stubbed" | "withheld" | "fallback";

/** Counts-only evidence of what the check hid (never values or content). */
export interface GuardEvidence {
  readonly outcome: GuardOutcome;
  readonly counts?: Partial<JsonCleanCounts> & { stubs?: number };
  /** The person's level, when it isn't the default (standard). */
  readonly level?: Exclude<ReadLevel, "standard">;
}

export interface GuardedResult {
  readonly result: unknown;
  readonly evidence: GuardEvidence;
  /** Content written by someone else that the agent was shown (for the "recently read" window). */
  readonly exposure?: ReadSource;
}

export interface ResultGuard {
  review(call: AgentCall, result: unknown): GuardedResult;
}

export interface ResultGuardDeps {
  /** The service's display name for a connector id (the catalogue name), for the result's source. */
  readonly serviceName?: (connectorId: string) => string | undefined;
  /** The service's catalogue category ("email", "messaging", …), for reads that bring in others' messages. */
  readonly category?: (connectorId: string) => string | undefined;
}

const COULD_NOT_CHECK_READ =
  "Warthog couldn't check this, so it isn't shown. Don't retry it in another format. Tell the person it's there and that they can open it in the service itself.";
const COULD_NOT_CHECK_CHANGE =
  "Done. Warthog couldn't check the service's reply, so it isn't shown.";

const GMAIL_READ = "google-gmail__read";
const GMAIL_SEARCH = "google-gmail__search";
const DRIVE_READ_TEXT = "google-drive__read_text";
const SUMMARY_FIELDS = ["id", "threadId", "labelIds", "date", "from", "subject", "preview", "withheld", "kind", "openInMail", "tellThePerson"] as const;
const OUTLOOK_READ = "microsoft-outlook-mail__read";
const OUTLOOK_SEARCH = "microsoft-outlook-mail__search";
const MAIL_CONNECTORS = MAIL_CONNECTOR_IDS;
const CALENDAR_CONNECTORS = new Set(["google-calendar", "microsoft-outlook-calendar"]);

function emptyJsonCounts(): JsonCleanCounts {
  return { hiddenCharacters: 0, signInLinks: 0, codes: 0, cards: 0, identifiers: 0, downloadLinks: 0 };
}

// The level a call is checked at: the person's, as the pipeline set it, else the default.
function levelOf(call: AgentCall): ReadLevel {
  return call.readLevel ?? DEFAULT_READ_LEVEL;
}

// The evidence for a checked result, naming the level when it isn't the default.
function evidenceOf(call: AgentCall, outcome: GuardOutcome, counts?: Partial<JsonCleanCounts> & { stubs?: number }): GuardEvidence {
  const level = levelOf(call);
  return { outcome, ...(counts ? { counts } : {}), ...(level !== "standard" ? { level } : {}) };
}

// Only the non-zero counts go into the evidence.
function nonZero(counts: JsonCleanCounts & { stubs?: number }): Partial<JsonCleanCounts> & { stubs?: number } | undefined {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) if (typeof value === "number" && value > 0) out[key] = value;
  return Object.keys(out).length ? out : undefined;
}

function outcomeOf(counts: JsonCleanCounts & { stubs?: number }, fallback: boolean): GuardOutcome {
  if (fallback) return "fallback";
  if ((counts.stubs ?? 0) > 0) return "stubbed";
  return anythingHidden(counts) || counts.downloadLinks > 0 ? "masked" : "shown";
}

function add(into: JsonCleanCounts & { stubs?: number }, from: FilterCounts): void {
  into.hiddenCharacters += from.hiddenCharacters;
  into.signInLinks += from.signInLinks;
  into.codes += from.codes;
  into.cards += from.cards;
  into.identifiers += from.identifiers;
}

// The curated / general-request envelope every REST connector returns.
interface Envelope {
  readonly status: number;
  readonly body: string;
  readonly truncated?: boolean;
  readonly tooLargeToCheck?: boolean;
  readonly note?: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return value !== null && typeof value === "object"
    && typeof (value as { status?: unknown }).status === "number"
    && typeof (value as { body?: unknown }).body === "string";
}

function isSuccess(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

// A read with query.link=N asks for just that numbered link in full (a long one is shown by
// its domain in the readable view). Only links the checked view kept can be asked for, so a
// hidden sign-in link never comes back this way.
function linkOnly(call: AgentCall, message: Record<string, unknown>): Record<string, unknown> | undefined {
  const asked = (call.params as { query?: Record<string, unknown> } | undefined)?.query?.link;
  if (asked === undefined) return undefined;
  const n = Number.parseInt(String(asked), 10);
  const links = Array.isArray(message.links) ? message.links : [];
  if (!Number.isInteger(n) || n < 1 || n > links.length) return { id: message.id, link: asked, note: "That link number isn't in this message." };
  return { id: message.id, link: n, url: links[n - 1] };
}

function gmailFormat(call: AgentCall): string | undefined {
  const query = (call.params as { query?: Record<string, unknown> } | undefined)?.query;
  return typeof query?.format === "string" ? query.format.toLowerCase() : undefined;
}

export function createResultGuard(deps: ResultGuardDeps = {}): ResultGuard {
  function source(call: AgentCall, kind: ContentKind): Record<string, unknown> {
    const service = call.connector ? deps.serviceName?.(call.connector) ?? call.connector : undefined;
    return {
      notice: untrustedNotice(kind),
      source: { ...(service ? { service } : {}), ...(call.connectorAccountLabel ? { account: call.connectorAccountLabel } : {}) },
    };
  }

  function mailViews(call: AgentCall, parsed: unknown, envelope: Envelope): { result: unknown; counts: JsonCleanCounts & { stubs?: number }; fallback: boolean } | null {
    const counts: JsonCleanCounts & { stubs?: number } = { ...emptyJsonCounts(), stubs: 0 };
    const level = levelOf(call);
    const tally = (view: MailView) => {
      add(counts, view.counts);
      if (view.stubbed) counts.stubs! += 1;
      return view.message;
    };
    if (call.tool === GMAIL_SEARCH && (parsed as { summaries?: unknown } | null)?.summaries === true) {
      const list = (parsed as { messages?: unknown }).messages;
      const messages = (Array.isArray(list) ? list : []).map((item) => {
        const missing = item as { id?: unknown; threadId?: unknown; unavailable?: unknown } | null;
        if (missing?.unavailable === true) {
          return { id: missing.id, threadId: missing.threadId, note: "Couldn't load this preview. Read the message by its id." };
        }
        const view = gmailMessageView(item, { account: call.connectorAccountLabel, headersOnly: true, level });
        if (!view) return { withheld: true, note: "Warthog couldn't check this message, so it isn't shown." };
        const message = tally(view);
        const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
        // A triage line: who, what, when, a preview and whether it's unread (a stub keeps its
        // note for the person) — not the headers an agent needs only to reply.
        const summary: Record<string, unknown> = {};
        for (const key of SUMMARY_FIELDS) if (message[key] !== undefined) summary[key] = message[key];
        return { ...summary, unread: labels.includes("UNREAD") };
      });
      const extra = parsed as { nextPageToken?: unknown; resultSizeEstimate?: unknown };
      return {
        result: {
          ...source(call, "email"), status: envelope.status, messages,
          ...(typeof extra.nextPageToken === "string" ? { nextPageToken: extra.nextPageToken } : {}),
          note: "Previews only: read a message by its id for its full text.",
        },
        counts,
        fallback: false,
      };
    }
    if (call.tool === GMAIL_READ) {
      const format = gmailFormat(call);
      const view = gmailMessageView(parsed, {
        account: call.connectorAccountLabel,
        tooLarge: envelope.tooLargeToCheck === true,
        headersOnly: format === "metadata" || format === "minimal",
        level,
      });
      if (!view) return null;
      const message = tally(view);
      return { result: { ...source(call, "email"), status: envelope.status, message: linkOnly(call, message) ?? message }, counts, fallback: view.fallback };
    }
    const tooLarge = envelope.tooLargeToCheck === true;
    const tooLargeNote = "This email is too large for Warthog to check, so its text isn't shown. The person can open it in Outlook.";
    if (call.tool === OUTLOOK_READ) {
      const view = outlookMessageView(parsed, { level });
      if (!view) return null;
      const message = tally(view);
      if (tooLarge && !view.stubbed) message.bodyNote = tooLargeNote;
      return { result: { ...source(call, "email"), status: envelope.status, message: linkOnly(call, message) ?? message }, counts, fallback: tooLarge };
    }
    if (call.tool === OUTLOOK_SEARCH) {
      const list = (parsed as { value?: unknown } | null)?.value;
      if (!Array.isArray(list)) return null;
      const messages = list.map((item) => {
        const view = outlookMessageView(item, { level });
        return view ? tally(view) : { withheld: true, note: "Warthog couldn't check this message, so it isn't shown." };
      });
      const next = (parsed as Record<string, unknown>)["@odata.nextLink"];
      return {
        result: {
          ...source(call, "email"), status: envelope.status, messages,
          ...(typeof next === "string" ? { nextLink: next } : {}),
          // How to ask for that page: Graph's own link can't be fetched by the agent.
          ...outlookPaging(next),
          note: "Previews only: read a message by its id for its full text.",
        },
        counts,
        fallback: tooLarge,
      };
    }
    return null;
  }

  function reviewEnvelope(call: AgentCall, envelope: Envelope): GuardedResult {
    // A failed request's reply never reaches the agent (the pipeline returns a plain reason).
    if (!isSuccess(envelope.status)) return { result: envelope, evidence: { outcome: "shown" } };
    const kind: ContentKind = call.connector && MAIL_CONNECTORS.has(call.connector) ? "email" : "content";
    const options: CleanOptions = { calendar: call.connector !== null && CALENDAR_CONNECTORS.has(call.connector), level: levelOf(call) };
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(envelope.body);
      isJson = true;
    } catch {
      parsed = undefined;
    }
    const mailTool = call.tool === GMAIL_READ || call.tool === OUTLOOK_READ || call.tool === OUTLOOK_SEARCH
      || (call.tool === GMAIL_SEARCH && /"summaries":true/.test(envelope.body));
    if (isJson) {
      const mail = mailViews(call, parsed, envelope);
      if (mail) return { result: mail.result, evidence: evidenceOf(call, outcomeOf(mail.counts, mail.fallback), nonZero(mail.counts)) };
    }
    // A mail reply that isn't whole JSON (cut short), or isn't a message, is never passed on raw.
    if (mailTool) return withheld(call, envelope.status);
    const counts = emptyJsonCounts();
    const body = isJson ? JSON.stringify(cleanJson(parsed, counts, options)) : cleanText(envelope.body, counts, options);
    // Warthog's own note on a Drive export (a sheet is read as its first tab only).
    const note = call.tool === DRIVE_READ_TEXT && typeof envelope.note === "string" ? { note: envelope.note } : {};
    return {
      result: { ...source(call, kind), status: envelope.status, body, truncated: envelope.truncated === true, ...note },
      evidence: evidenceOf(call, outcomeOf(counts, false), nonZero(counts)),
    };
  }

  // A provider-hosted tool's MCP result: its text blocks and structured content are checked.
  function reviewProvider(call: AgentCall, result: Record<string, unknown>): GuardedResult {
    const counts = emptyJsonCounts();
    const options: CleanOptions = { level: levelOf(call) };
    const out: Record<string, unknown> = { ...source(call, "content") };
    for (const [key, value] of Object.entries(result)) {
      if (key === "content" && Array.isArray(value)) {
        out.content = value.map((block) => {
          const b = (block ?? {}) as { type?: unknown; text?: unknown; uri?: unknown; name?: unknown; resource?: { uri?: unknown; mimeType?: unknown; text?: unknown } };
          if (b.type === "text" && typeof b.text === "string") return { type: "text", text: cleanText(b.text, counts, options) };
          // An embedded text resource is read like text; a link to one keeps its address and name.
          if (b.type === "resource" && typeof b.resource?.text === "string") {
            return { type: "resource", resource: {
              ...(typeof b.resource.uri === "string" ? { uri: cleanText(b.resource.uri, counts, options) } : {}),
              ...(typeof b.resource.mimeType === "string" ? { mimeType: b.resource.mimeType } : {}),
              text: cleanText(b.resource.text, counts, options),
            } };
          }
          if (b.type === "resource_link" && typeof b.uri === "string") {
            return { type: "resource_link", uri: cleanText(b.uri, counts, options), ...(typeof b.name === "string" ? { name: cleanText(b.name, counts, options) } : {}) };
          }
          // Images, audio and binary resources are not passed on: they can't be checked.
          return { type: "text", text: "[non-text content withheld by Warthog]" };
        });
      } else if (key === "structuredContent") {
        out.structuredContent = cleanJson(value, counts, options);
      } else if (key === "isError" || key === "_meta") {
        if (key === "isError") out.isError = value;
      } else {
        out[key] = cleanJson(value, counts, options);
      }
    }
    return { result: out, evidence: evidenceOf(call, outcomeOf(counts, false), nonZero(counts)) };
  }

  function withheld(call: AgentCall, status: number | undefined): GuardedResult {
    const kind: ContentKind = call.connector && MAIL_CONNECTORS.has(call.connector) ? "email" : "content";
    return {
      result: call.makesChange
        ? { ...source(call, kind), ...(status === undefined ? {} : { status }), done: true, note: COULD_NOT_CHECK_CHANGE }
        : { ...source(call, kind), ...(status === undefined ? {} : { status }), withheld: true, note: COULD_NOT_CHECK_READ },
      evidence: evidenceOf(call, "withheld"),
    };
  }

  // What the agent was shown that someone else wrote, if anything (read-side protection's
  // "recently read" window). Mail the person sent or drafted, events they organised and the
  // person's own tools don't count.
  function exposureOf(call: AgentCall, guarded: GuardedResult): ReadSource | undefined {
    if (!call.connector || guarded.evidence.outcome === "withheld") return undefined;
    const service = deps.serviceName?.(call.connector) ?? call.connector;
    const result = (guarded.result ?? {}) as Record<string, unknown>;
    if (call.tool === GMAIL_READ) {
      // Asking for one numbered link shows just its address, not the email again.
      if ((call.params as { query?: { link?: unknown } } | undefined)?.query?.link !== undefined) return undefined;
      const message = (result.message ?? {}) as { labelIds?: unknown; from?: unknown };
      const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
      if (labels.includes("SENT") || labels.includes("DRAFT")) return undefined;
      return { service, kind: "email", ...senderOf(message.from) };
    }
    // Outlook messages carry no Sent/Draft label in the view, so mail from the person's own
    // address doesn't count (a sender can fake that only to keep the window shut on themselves).
    const own = call.connectorAccountLabel?.toLowerCase();
    const fromSomeoneElse = (from: unknown) => senderOf(from).sender !== own;
    if (call.tool === OUTLOOK_READ) {
      const from = (result.message as { from?: unknown } | undefined)?.from;
      return fromSomeoneElse(from) ? { service, kind: "email", ...senderOf(from) } : undefined;
    }
    // A search shows each message's preview, so the first one someone else wrote counts.
    if (call.tool === OUTLOOK_SEARCH || call.tool === GMAIL_SEARCH) {
      const list = Array.isArray(result.messages) ? (result.messages as { from?: unknown; labelIds?: unknown }[]) : [];
      const mine = (m: { labelIds?: unknown }) => Array.isArray(m.labelIds) && (m.labelIds.includes("SENT") || m.labelIds.includes("DRAFT"));
      const first = list.find((m) => !mine(m) && m.from !== undefined && fromSomeoneElse(m.from));
      return first ? { service, kind: "email", ...senderOf(first.from) } : undefined;
    }
    if (call.tool === "google-calendar__list" || call.tool === "microsoft-outlook-calendar__list") {
      let events: unknown[] = [];
      try {
        const body = JSON.parse(String(result.body)) as { items?: unknown; value?: unknown };
        events = Array.isArray(body.items) ? body.items : Array.isArray(body.value) ? body.value : [];
      } catch {
        // A list cut short (or otherwise unreadable) was still shown as text: count it.
        return { service, kind: "event" };
      }
      if (result.truncated === true) return { service, kind: "event" };
      const foreign = events.find((event) => {
        const e = (event ?? {}) as { organizer?: { self?: unknown }; isOrganizer?: unknown };
        return e.organizer?.self !== true && e.isOrganizer !== true;
      }) as { organizer?: { email?: unknown; emailAddress?: { address?: unknown } } } | undefined;
      return foreign ? { service, kind: "event", ...senderOf(foreign.organizer?.email ?? foreign.organizer?.emailAddress?.address) } : undefined;
    }
    // A file Warthog couldn't read showed nothing anyone wrote.
    if (call.tool === DRIVE_READ_TEXT) return /"unreadable":true/.test(String(result.body)) ? undefined : { service, kind: "file" };
    if (call.requiresApproval) return { service, kind: "content" };
    // A read (GET/HEAD — even through a service where every request counts as a change, like
    // ntfy) of a service that carries other people's messages or bookings.
    if (call.tool === `${call.connector}__request`) {
      const method = String((call.params as { method?: unknown } | undefined)?.method ?? "").toUpperCase();
      const category = deps.category?.(call.connector);
      return (method === "GET" || method === "HEAD") && (category === "email" || category === "messaging" || category === "calendar")
        ? { service, kind: "message" } : undefined;
    }
    return undefined;
  }

  return {
    review(call: AgentCall, result: unknown): GuardedResult {
      const guarded = reviewResult(call, result);
      const exposure = exposureOf(call, guarded);
      // Which of the person's accounts it was read in, so the card can name the inbox.
      if (exposure && call.connectorAccountLabel) return { ...guarded, exposure: { ...exposure, account: call.connectorAccountLabel } };
      return exposure ? { ...guarded, exposure } : guarded;
    },
  };

  // The check itself: never throws (a result it can't check is withheld).
  function reviewResult(call: AgentCall, result: unknown): GuardedResult {
    const status = result && typeof result === "object" && typeof (result as { status?: unknown }).status === "number"
      ? (result as { status: number }).status : undefined;
    try {
      if (isEnvelope(result)) return reviewEnvelope(call, result);
      if (result && typeof result === "object" && !Array.isArray(result)) return reviewProvider(call, result as Record<string, unknown>);
      const counts = emptyJsonCounts();
      return { result: cleanJson(result, counts, { level: levelOf(call) }), evidence: evidenceOf(call, outcomeOf(counts, false), nonZero(counts)) };
    } catch {
      return withheld(call, status);
    }
  }
}

// The address in a "Name <address>" header value, when there is one.
// The LAST angle-address is the real one: a display name can contain a fake one
// ("Westpac <alerts@westpac.com.au>" <evil@x.co>).
function senderOf(value: unknown): { sender?: string } {
  if (typeof value !== "string") return {};
  const angled = [...value.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].at(-1)?.[1];
  const address = angled ?? (/^[^\s<>]+@[^\s<>]+$/.test(value.trim()) ? value.trim() : undefined);
  return address ? { sender: address.toLowerCase().slice(0, 254) } : {};
}
