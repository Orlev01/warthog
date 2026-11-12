/** Content-minimal observations: never persist tool response bodies or provider prose. */
export function observeResult(value: unknown): {
  outcome: "executed" | "failed" | "refused" | "unknown";
  evidence: Record<string, unknown>;
} {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const status = typeof result.status === "number" ? result.status : undefined;
  let body: unknown = result;
  if (typeof result.body === "string") {
    try { body = JSON.parse(result.body); } catch { body = null; }
  }
  // Some APIs (for example Slack) return HTTP 200 with an explicit `ok:false`.
  // Do not classify arbitrary message text or a resource's own status as an error.
  const businessFailure = result.ok === false || (status !== undefined && body !== null && typeof body === "object" && "ok" in body && body.ok === false);
  const outcome = ["refused", "not_available", "gone"].includes(String(result.status)) ? "refused"
    : result.status === "unknown" ? "unknown"
    : result.isError === true || businessFailure || result.status === "failed" || (status !== undefined && (status < 200 || status >= 300)) ? "failed" : "executed";
  const evidence: Record<string, unknown> = { outcome, ...(status === undefined ? {} : { status }), ...(result.isError === true ? { providerError: true } : {}) };
  if (businessFailure) evidence.businessError = true;
  if (typeof result.truncated === "boolean") evidence.truncated = result.truncated;
  if (body && typeof body === "object") {
    const data = body as Record<string, unknown>;
    const counts: Record<string, number> = {};
    const references: Record<string, string[]> = {};
    for (const key of ["messages", "threads", "items", "files", "events", "value", "memory", "memories", "records", "tasks", "skills", "tools"]) {
      if (!Array.isArray(data[key])) continue;
      counts[key] = data[key].length;
      references[key] = data[key].slice(0, 20).flatMap(item => item && typeof item.id === "string" ? [item.id.slice(0, 200)] : []);
    }
    if (Array.isArray(body)) counts.items = body.length;
    if (Object.keys(counts).length) evidence.counts = counts;
    if (Object.values(references).some(ids => ids.length)) evidence.references = references;
    if (typeof data.id === "string") evidence.reference = data.id.slice(0, 200);
    if (data.profile && typeof data.profile === "object") evidence.profileFields = Array.isArray(data.profile) ? data.profile.slice(0, 100).flatMap(field => typeof field?.kind === "string" ? [field.kind] : []) : Object.keys(data.profile).slice(0, 100);
  }
  return { outcome, evidence };
}
