// Client release posting (design §4.2 "Release").
//
// On approval, after step-up, the browser decrypts the high-tier value or card
// detail with the vault key and hands it to Warthog for the single release. This
// module is the CLIENT half of that hand-over: it POSTs the already-decrypted
// value to the approval's release endpoint over the authenticated same-origin
// session, resolving when the server accepts it and rejecting with a plain
// message when it does not.
//
// The decrypted value is held ONLY for the in-flight request. It travels in the
// request BODY — never the URL path (URLs get logged) — and this module keeps no
// module-level state, never writes the value to client storage or the console,
// and retains nothing across calls: each call carries only its own arguments.
//
// Browser code: it reaches the global `fetch` at call time (so the same-origin
// POST carries the session cookie) and never a DOM, a database, or Node APIs.

// The release endpoint for a pending approval. The approval id goes in the path;
// the decrypted value never does.
function releaseUrl(approvalId: string): string {
  return `/api/approvals/${encodeURIComponent(approvalId)}/release`;
}

// A release the server refused, carrying its HTTP status and the server's stable error
// code (e.g. "step_up_required", "over_budget"; null when the body had none) so the
// inbox can offer the right next step. Its message is plain and never names the value.
export class ReleaseRejectedError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`The release could not be completed (status ${status}).`);
    this.name = "ReleaseRejectedError";
    this.status = status;
    this.code = code;
  }
}

// The `{ error }` code of a refusal body, or null when the body is not that shape.
async function errorCodeOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

// Hand the decrypted value to Warthog for its single release. Resolves on a 2xx;
// rejects with a ReleaseRejectedError (that never names the value) on a non-2xx, and
// lets a thrown request (offline) surface as a rejection rather than resolving silently.
export async function postRelease(approvalId: string, value: string, fieldId?:string): Promise<void> {
  const response = await fetch(releaseUrl(approvalId), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value, ...(fieldId?{fieldId}:{}) }),
  });

  if (!response.ok) {
    throw new ReleaseRejectedError(response.status, await errorCodeOf(response));
  }
}
