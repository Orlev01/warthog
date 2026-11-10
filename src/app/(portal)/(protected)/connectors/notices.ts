import type { NoticeTone } from "@/components/ui/notice";

type ConnectorNotice = { readonly tone: NoticeTone; readonly text: string };

const notices: Record<string, ConnectorNotice> = {
  "provider-revoke-needed": { tone: "info", text: "Disconnected from Warthog. To remove the provider’s consent too, open your Google or Microsoft account’s app permissions and remove Warthog." },
  "connection-declined": { tone: "info", text: "The service was not connected. You can try again when you are ready." },
  disconnected: { tone: "success", text: "Service disconnected." },
  connected: { tone: "success", text: "Service connected." },
  requested: { tone: "success", text: "Thanks — we've recorded your request." },
  "key-needed": { tone: "info", text: "Enter your key to finish connecting this service." },
  problem: { tone: "error", text: "Something went wrong. Please try again." },
};

// Use the same catalogue for recognition and presentation so a known outcome
// cannot be accidentally filtered out before its follow-up instructions render.
export function connectorNotice(raw: string | string[] | undefined): ConnectorNotice | null {
  return typeof raw === "string" && Object.hasOwn(notices, raw) ? notices[raw]! : null;
}
