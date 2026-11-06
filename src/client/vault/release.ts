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

// Hand the decrypted value to Warthog for its single release. Resolves on a 2xx;
// rejects with a plain Error (that never names the value) on a non-2xx, and lets a
// thrown request (offline) surface as a rejection rather than resolving silently.
export async function postRelease(approvalId: string, value: string): Promise<void> {
  const response = await fetch(releaseUrl(approvalId), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

  if (!response.ok) {
    throw new Error(`The release could not be completed (status ${response.status}).`);
  }
}
