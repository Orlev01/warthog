/** Dated acceptance evidence, deliberately separate from setup availability.
 * Local transport tests do not establish a live provider's current behavior. */
const locallyTested = new Set([
  "google-gmail", "google-calendar", "google-drive",
  "microsoft-outlook-mail", "microsoft-outlook-calendar", "microsoft-onedrive",
]);
export function connectorVerification(id: string) {
  const gmail = id === "google-gmail";
  return {
    local: locallyTested.has(id) ? "protocol_tested" as const : "configured" as const,
    live: gmail ? {
      testedAt: "2026-11-12",
      client: "Claude",
      operations: ["context", "search", "read"],
      connect: "observed", identity: "unverified", read: "observed",
      writeApproval: "unverified", error: "unverified", refresh: "unverified",
      reconnect: "unverified", revoke: "unverified",
    } : null,
    label: gmail ? "Live search/read verified 12 Nov 2026 · sending not verified"
      : locallyTested.has(id) ? "Protocol tested locally · live verification not recorded"
      : "Configured integration · live verification not recorded",
  };
}
