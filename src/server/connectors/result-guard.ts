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
// Never throws: a result Warthog cannot check is not shown (a read) or is reported done
// without the service's reply (a change — so the agent never retries a change that happened).
// Deterministic code only (brief no-ai-model-calls); counts only in the evidence, never
// content.

import { cleanJson, type JsonCleanCounts } from "../../domain/content/json-clean";
import { gmailMessageView, type MailView } from "../../domain/content/gmail-message";
import { outlookMessageView } from "../../domain/content/outlook-message";
import { anythingHidden, cleanText, type FilterCounts } from "../../domain/content/text-filters";
import { untrustedNotice, type ContentKind } from "../../domain/content/untrusted";
import type { AgentCall } from "../mcp/pipeline";
import type { ReadSource } from "../db/read-exposures";

/** How a checked result was handled — the `agent.read_guard` metric's outcome label. */
export type GuardOutcome = "shown" | "masked" | "stubbed" | "withheld" | "fallback";

/** Counts-only evidence of what the check hid (never values or content). */
export interface GuardEvidence {
  readonly outcome: GuardOutcome;
  readonly counts?: Partial<JsonCleanCounts> & { stubs?: number };
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
const OUTLOOK_READ = "microsoft-outlook-mail__read";
const OUTLOOK_SEARCH = "microsoft-outlook-mail__search";
const MAIL_CONNECTORS = new Set(["google-gmail", "microsoft-outlook-mail"]);
const CALENDAR_CONNECTORS = new Set(["google-calendar", "microsoft-outlook-calendar"]);

function emptyJsonCounts(): JsonCleanCounts {
  return { hiddenCharacters: 0, signInLinks: 0, codes: 0, cards: 0, downloadLinks: 0 };
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
}

// The curated / general-request envelope every REST connector returns.
interface Envelope {
  readonly status: number;
  readonly body: string;
  readonly truncated?: boolean;
  readonly tooLargeToCheck?: boolean;
}

function isEnvelope(value: unknown): value is Envelope {
  return value !== null && typeof value === "object"
    && typeof (value as { status?: unknown }).status === "number"
    && typeof (value as { body?: unknown }).body === "string";
}

function isSuccess(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
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
    const tally = (view: MailView) => {
      add(counts, view.counts);
      if (view.stubbed) counts.stubs! += 1;
      return view.message;
    };
    if (call.tool === GMAIL_READ) {
      const format = gmailFormat(call);
      const view = gmailMessageView(parsed, {
        account: call.connectorAccountLabel,
        tooLarge: envelope.tooLargeToCheck === true,
        headersOnly: format === "metadata" || format === "minimal",
      });
      if (!view) return null;
      return { result: { ...source(call, "email"), status: envelope.status, message: tally(view) }, counts, fallback: view.fallback };
    }
    const tooLarge = envelope.tooLargeToCheck === true;
    const tooLargeNote = "This email is too large for Warthog to check, so its text isn't shown. The person can open it in Outlook.";
    if (call.tool === OUTLOOK_READ) {
      const view = outlookMessageView(parsed);
      if (!view) return null;
      const message = tally(view);
      if (tooLarge && !view.stubbed) message.bodyNote = tooLargeNote;
      return { result: { ...source(call, "email"), status: envelope.status, message }, counts, fallback: tooLarge };
    }
    if (call.tool === OUTLOOK_SEARCH) {
      const list = (parsed as { value?: unknown } | null)?.value;
      if (!Array.isArray(list)) return null;
      const messages = list.map((item) => {
        const view = outlookMessageView(item);
        return view ? tally(view) : { withheld: true, note: "Warthog couldn't check this message, so it isn't shown." };
      });
      const next = (parsed as Record<string, unknown>)["@odata.nextLink"];
      return {
        result: {
          ...source(call, "email"), status: envelope.status, messages,
          ...(typeof next === "string" ? { nextLink: next } : {}),
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
    const options = { calendar: call.connector !== null && CALENDAR_CONNECTORS.has(call.connector) };
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(envelope.body);
      isJson = true;
    } catch {
      parsed = undefined;
    }
    const mailTool = call.tool === GMAIL_READ || call.tool === OUTLOOK_READ || call.tool === OUTLOOK_SEARCH;
    if (isJson) {
      const mail = mailViews(call, parsed, envelope);
      if (mail) return { result: mail.result, evidence: { outcome: outcomeOf(mail.counts, mail.fallback), counts: nonZero(mail.counts) } };
    }
    // A mail reply that isn't whole JSON (cut short), or isn't a message, is never passed on raw.
    if (mailTool) return withheld(call, envelope.status);
    const counts = emptyJsonCounts();
    const body = isJson ? JSON.stringify(cleanJson(parsed, counts, options)) : cleanText(envelope.body, counts, options);
    return {
      result: { ...source(call, kind), status: envelope.status, body, truncated: envelope.truncated === true },
      evidence: { outcome: outcomeOf(counts, false), counts: nonZero(counts) },
    };
  }

  // A provider-hosted tool's MCP result: its text blocks and structured content are checked.
  function reviewProvider(call: AgentCall, result: Record<string, unknown>): GuardedResult {
    const counts = emptyJsonCounts();
    const out: Record<string, unknown> = { ...source(call, "content") };
    for (const [key, value] of Object.entries(result)) {
      if (key === "content" && Array.isArray(value)) {
        out.content = value.map((block) => {
          const b = (block ?? {}) as { type?: unknown; text?: unknown; uri?: unknown; name?: unknown; resource?: { uri?: unknown; mimeType?: unknown; text?: unknown } };
          if (b.type === "text" && typeof b.text === "string") return { type: "text", text: cleanText(b.text, counts) };
          // An embedded text resource is read like text; a link to one keeps its address and name.
          if (b.type === "resource" && typeof b.resource?.text === "string") {
            return { type: "resource", resource: {
              ...(typeof b.resource.uri === "string" ? { uri: cleanText(b.resource.uri, counts) } : {}),
              ...(typeof b.resource.mimeType === "string" ? { mimeType: b.resource.mimeType } : {}),
              text: cleanText(b.resource.text, counts),
            } };
          }
          if (b.type === "resource_link" && typeof b.uri === "string") {
            return { type: "resource_link", uri: cleanText(b.uri, counts), ...(typeof b.name === "string" ? { name: cleanText(b.name, counts) } : {}) };
          }
          // Images, audio and binary resources are not passed on: they can't be checked.
          return { type: "text", text: "[non-text content withheld by Warthog]" };
        });
      } else if (key === "structuredContent") {
        out.structuredContent = cleanJson(value, counts);
      } else if (key === "isError" || key === "_meta") {
        if (key === "isError") out.isError = value;
      } else {
        out[key] = cleanJson(value, counts);
      }
    }
    return { result: out, evidence: { outcome: outcomeOf(counts, false), counts: nonZero(counts) } };
  }

  function withheld(call: AgentCall, status: number | undefined): GuardedResult {
    const kind: ContentKind = call.connector && MAIL_CONNECTORS.has(call.connector) ? "email" : "content";
    return {
      result: call.makesChange
        ? { ...source(call, kind), ...(status === undefined ? {} : { status }), done: true, note: COULD_NOT_CHECK_CHANGE }
        : { ...source(call, kind), ...(status === undefined ? {} : { status }), withheld: true, note: COULD_NOT_CHECK_READ },
      evidence: { outcome: "withheld" },
    };
  }

  // What the agent was shown that someone else wrote, if anything (read-side protection's
  // "recently read" window). Mail the person sent or drafted, events they organised and the
  // person's own tools don't count; Gmail search (ids only) doesn't either.
  function exposureOf(call: AgentCall, guarded: GuardedResult): ReadSource | undefined {
    if (!call.connector || guarded.evidence.outcome === "withheld") return undefined;
    const service = deps.serviceName?.(call.connector) ?? call.connector;
    const result = (guarded.result ?? {}) as Record<string, unknown>;
    if (call.tool === GMAIL_READ) {
      const message = (result.message ?? {}) as { labelIds?: unknown; from?: unknown };
      const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
      if (labels.includes("SENT") || labels.includes("DRAFT")) return undefined;
      return { service, kind: "email", ...senderOf(message.from) };
    }
    if (call.tool === OUTLOOK_READ) return { service, kind: "email", ...senderOf((result.message as { from?: unknown } | undefined)?.from) };
    if (call.tool === OUTLOOK_SEARCH) {
      const first = Array.isArray(result.messages) ? (result.messages[0] as { from?: unknown } | undefined) : undefined;
      return first ? { service, kind: "email", ...senderOf(first.from) } : undefined;
    }
    if (call.tool === "google-calendar__list" || call.tool === "microsoft-outlook-calendar__list") {
      let events: unknown[] = [];
      try {
        const body = JSON.parse(String(result.body)) as { items?: unknown; value?: unknown };
        events = Array.isArray(body.items) ? body.items : Array.isArray(body.value) ? body.value : [];
      } catch {
        return undefined;
      }
      const foreign = events.find((event) => {
        const e = (event ?? {}) as { organizer?: { self?: unknown }; isOrganizer?: unknown };
        return e.organizer?.self !== true && e.isOrganizer !== true;
      }) as { organizer?: { email?: unknown; emailAddress?: { address?: unknown } } } | undefined;
      return foreign ? { service, kind: "event", ...senderOf(foreign.organizer?.email ?? foreign.organizer?.emailAddress?.address) } : undefined;
    }
    if (call.tool === "google-drive__read_text") return { service, kind: "file" };
    if (call.requiresApproval) return { service, kind: "content" };
    if (call.tool === `${call.connector}__request` && !call.makesChange) {
      const category = deps.category?.(call.connector);
      return category === "email" || category === "messaging" ? { service, kind: "message" } : undefined;
    }
    return undefined;
  }

  return {
    review(call: AgentCall, result: unknown): GuardedResult {
      const guarded = reviewResult(call, result);
      const exposure = exposureOf(call, guarded);
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
      return { result: cleanJson(result, counts), evidence: { outcome: outcomeOf(counts, false), counts: nonZero(counts) } };
    } catch {
      return withheld(call, status);
    }
  }
}

// The address in a "Name <address>" header value, when there is one.
function senderOf(value: unknown): { sender?: string } {
  if (typeof value !== "string") return {};
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? (/^[^\s<>]+@[^\s<>]+$/.test(value.trim()) ? value.trim() : undefined);
  return address ? { sender: address.toLowerCase().slice(0, 254) } : {};
}
