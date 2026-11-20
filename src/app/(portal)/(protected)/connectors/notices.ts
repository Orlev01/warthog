import type { NoticeTone } from "@/components/ui/notice";
import { hrefWith } from "@/lib/href";

type ConnectorNotice = { readonly tone: NoticeTone; readonly text: string };

// Plain words for each outcome: what happened and, when something didn't, what to do next.
// "Service" is what a person connects; "API key" is the provider's secret (never "access
// key", which is the key Warthog issues to an agent, and never "credential").
const notices: Record<string, ConnectorNotice> = {
  "key-saved": { tone: "success", text: "Service connected. Next, turn it on for the agents that should use it, on each agent's page. Some services can only check a key the first time it's used." },
  "verification-failed": { tone: "error", text: "We saved your key, but the service didn't accept it. Disconnect that account under Your services, then connect again with a different key." },
  "provider-revoke-needed": { tone: "info", text: "Disconnected from Warthog. To remove the provider’s consent too, open that account’s app permissions (on LinkedIn, Settings › Data privacy › Permitted services) and remove Warthog." },
  "connection-declined": { tone: "info", text: "That service was not connected. You can try again when you're ready." },
  disconnected: { tone: "success", text: "Service disconnected. No agent can use it now." },
  connected: { tone: "success", text: "Service connected." },
  requested: { tone: "success", text: "Thanks — we've recorded your request." },
  "early-access-requested": { tone: "success", text: "Thanks — we've asked for you to join early access. Once you're added, you can connect it here." },
  "request-name-missing": { tone: "error", text: "Type the name of the service you'd like us to add, then send the request." },
  "key-needed": { tone: "info", text: "Enter your key to finish connecting this service." },
  "connect-problem": { tone: "error", text: "We couldn't start connecting that service. Please try again." },
  renamed: { tone: "success", text: "Name saved." },
  "rename-problem": { tone: "error", text: "We couldn't save that name. Use a few words, then try again." },
  "disconnect-problem": { tone: "error", text: "We couldn't disconnect that service. Refresh the page to check it's still listed, then try again." },
  "request-problem": { tone: "error", text: "We couldn't send that request. Please try again." },
  problem: { tone: "error", text: "We couldn't finish that just now. Please try again." },
};

// Use the same catalogue for recognition and presentation so a known outcome
// cannot be accidentally filtered out before its follow-up instructions render.
export function connectorNotice(raw: string | string[] | undefined): ConnectorNotice | null {
  return typeof raw === "string" && Object.hasOwn(notices, raw) ? notices[raw]! : null;
}

// Where a Connectors action brings the person back to, with its notice: the tab, search and
// category the form says they were on (interaction-14), so a connect problem or a request
// doesn't throw them back to the first tab of an unfiltered page. Untrusted: only the known
// tabs and bounded strings are kept, and the path is always /connectors (hrefWith never
// emits another origin); the page's loader validates the category again before it narrows
// anything.
const RETURN_VIEWS = new Set(["connected", "catalogue"]);
export function connectorsReturnUrl(formData: FormData, notice: string): string {
  const field = (name: string) => {
    const raw = formData.get(name);
    return typeof raw === "string" ? raw : "";
  };
  const view = field("return_view");
  const inCatalogue = view === "catalogue";
  return hrefWith("/connectors", {
    view: RETURN_VIEWS.has(view) ? view : undefined,
    q: inCatalogue ? field("return_q").slice(0, 200) : undefined,
    category: inCatalogue ? field("return_category").slice(0, 128) : undefined,
    notice,
  });
}
