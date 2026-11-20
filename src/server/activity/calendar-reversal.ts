import { z } from "zod";

import { isLinkedInPostUrn } from "../../domain/content/linkedin-post";

// The curated tools Undo can reverse, each with the tool that undoes it, the query key that tool
// takes the resource's id in, and the shape that id must have. The stored target keeps its
// `eventId` key for every service, so entries recorded before LinkedIn still read.
interface Reversal {
  readonly tool: string;
  readonly param: string;
  readonly id: (value: string) => boolean;
}

// Calendar resource identifiers are opaque. Refuse URLs, whitespace, oversized values
// and redaction placeholders; never persist the provider's event body as Undo metadata.
const calendarId = (value: string) => /^[A-Za-z0-9_+\/-]+={0,2}$/.test(value);

const reversals: Readonly<Record<string, Reversal>> = {
  "google-calendar__create": { tool: "google-calendar__delete", param: "eventId", id: calendarId },
  "microsoft-outlook-calendar__create": { tool: "microsoft-outlook-calendar__delete", param: "eventId", id: calendarId },
  // A post LinkedIn named in `x-restli-id` (docs/adr/linkedin-connector.md).
  "linkedin__create_post": { tool: "linkedin__delete_post", param: "id", id: isLinkedInPostUrn },
};

const targetSchema = z.object({ tool: z.string(), eventId: z.string().min(1).max(1024) }).strict();
export type CalendarReversal = z.infer<typeof targetSchema>;

export function successfulConnectorResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const status = (result as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) && status >= 200 && status < 300;
}

export function calendarReversalFromResult(tool: string, result: unknown): CalendarReversal | undefined {
  const reversal = reversals[tool];
  if (!reversal || !successfulConnectorResult(result)) return undefined;
  const response = result as { body?: unknown; truncated?: unknown };
  if (response.truncated || typeof response.body !== "string" || response.body.length > 100_000) return undefined;
  try {
    const body: unknown = JSON.parse(response.body);
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    const parsed = targetSchema.safeParse({ tool: reversal.tool, eventId: id });
    return parsed.success && reversal.id(parsed.data.eventId) ? parsed.data : undefined;
  } catch { return undefined; }
}

export function calendarReversalForEntry(entry: {
  tool?: string; source: string; kind: string; outcome?: string; payload: unknown;
}): CalendarReversal | undefined {
  if (entry.source !== "warthog" || entry.kind !== "tool_call" || entry.outcome !== "executed" || !entry.tool) return undefined;
  const payload = entry.payload;
  const parsed = targetSchema.safeParse(payload && typeof payload === "object" ? (payload as { reversal?: unknown }).reversal : undefined);
  const reversal = reversals[entry.tool];
  return parsed.success && reversal?.tool === parsed.data.tool && reversal.id(parsed.data.eventId) ? parsed.data : undefined;
}

/**
 * The Undo target a Warthog tool call carries, when it is exactly what `calendarReversalFromResult`
 * produces for that tool: the reversing tool and an id of that service's own shape, read from the
 * provider's response. The activity writer keeps it as stored (docs/adr/linkedin-connector.md):
 * it is the provider's opaque id, never text from an agent or a person, and a 19-digit LinkedIn
 * post id can pass the card-number check, so masking it would break Undo.
 */
export function reversalTargetOf(tool: string | undefined, payload: unknown): CalendarReversal | undefined {
  const reversal = tool ? reversals[tool] : undefined;
  if (!reversal || !payload || typeof payload !== "object") return undefined;
  const parsed = targetSchema.safeParse((payload as { reversal?: unknown }).reversal);
  return parsed.success && parsed.data.tool === reversal.tool && reversal.id(parsed.data.eventId) ? parsed.data : undefined;
}

/** The query the reversing tool is called with: the resource's id under that tool's key. */
export function reversalQuery(target: CalendarReversal): Record<string, string> {
  const param = Object.values(reversals).find((reversal) => reversal.tool === target.tool)?.param ?? "eventId";
  return { [param]: target.eventId };
}
