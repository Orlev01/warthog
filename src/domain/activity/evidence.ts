import { redact } from "../redaction/redact";
import { entryTitle, humanise } from "./describe";

export interface EvidenceEntry {
  kind: string;
  tool?: string;
  outcome?: string;
  payload: unknown;
}

/** One presentation contract for historical and current, already-redacted events.
 * Unknown payload fields are not dumped; new event kinds must opt into safe detail.
 */
export function activityEvidence(entry: EvidenceEntry): { summary: string; detail: string } {
  const safe = redact(entry.payload, () => false) as Record<string, unknown> | null;
  const payload = safe && typeof safe === "object" ? safe : {};
  const text = (key: string): string => typeof payload[key] === "string" ? payload[key] as string : "";
  const summary = text("summary") || text("reason") || entryTitle(entry);
  const lines: string[] = [];
  if (text("detail")) lines.push(text("detail"));
  if (text("reason")) lines.push(`Supplied reason: ${text("reason")}`);
  if (text("connectorAccountLabel") || text("connectorAccountId")) {
    lines.push(`Service account: ${text("connectorAccountLabel") || text("connectorAccountId")}`);
  }
  if (text("requestId")) lines.push(`Request: ${text("requestId")}`);
  if (text("attemptId")) lines.push(`Attempt: ${text("attemptId")}`);
  if (text("reportedRunId")) lines.push(`Client-reported run: ${text("reportedRunId")}`);
  if (text("policyFingerprint")) lines.push(`Policy version: ${text("policyFingerprint")}`);
  for (const [key, label] of [["params", "Parameters"], ["decision", "Policy decision"], ["resultEvidence", "Observed result"], ["changes", "Changes"], ["client", "Client-reported metadata"], ["before", "Before"], ["after", "After"], ["skillChoices", "Skill access"], ["memoryChoices", "Memory access"], ["approvalId", "Approval"], ["sentence", "Request"], ["question", "Requested clarification"], ["scope", "Scope"], ["memoryId", "Memory"], ["actor", "Actor"]] as const) {
    if (payload[key] !== undefined) lines.push(`${label}: ${JSON.stringify(payload[key], null, 2)}`);
  }
  if (typeof payload.durationMs === "number") lines.push(`Duration: ${payload.durationMs} ms`);
  if (entry.kind === "tool_attempt") lines.push("This entry records intent before execution. It does not confirm completion. Look for a matching attempt and check the service before repeating an unfinished change.");
  if (entry.kind === "tool_call" && payload.resultEvidence === undefined) {
    lines.push(entry.outcome === "executed"
      ? "Historical outcome: Executed. Upstream success was not independently recorded."
      : `Outcome: ${humanise(entry.outcome ?? "unavailable")}`);
    lines.push("Result details were not recorded for this event.");
  }
  return { summary, detail: lines.join("\n\n") || "No additional detail was recorded for this event." };
}
