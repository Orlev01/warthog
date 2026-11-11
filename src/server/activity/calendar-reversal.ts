import { z } from "zod";

const reversals: Readonly<Record<string, string>> = {
  "google-calendar__create": "google-calendar__delete",
  "microsoft-outlook-calendar__create": "microsoft-outlook-calendar__delete",
};

// Calendar resource identifiers are opaque. Refuse URLs, whitespace, oversized values
// and redaction placeholders; never persist the provider's event body as Undo metadata.
const eventId = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_+\/-]+={0,2}$/);
const targetSchema = z.object({ tool: z.string(), eventId }).strict();
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
    const id = eventId.safeParse(body && typeof body === "object" ? (body as { id?: unknown }).id : undefined);
    return id.success ? { tool: reversal, eventId: id.data } : undefined;
  } catch { return undefined; }
}

export function calendarReversalForEntry(entry: {
  tool?: string; source: string; kind: string; outcome?: string; payload: unknown;
}): CalendarReversal | undefined {
  if (entry.source !== "warthog" || entry.kind !== "tool_call" || entry.outcome !== "executed" || !entry.tool) return undefined;
  const payload = entry.payload;
  const parsed = targetSchema.safeParse(payload && typeof payload === "object" ? (payload as { reversal?: unknown }).reversal : undefined);
  return parsed.success && reversals[entry.tool] === parsed.data.tool ? parsed.data : undefined;
}
