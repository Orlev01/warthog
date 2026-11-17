import { createHash } from "node:crypto";
import { processSingleton } from "../seams/process-singleton";
import { systemClock } from "../seams/clock";
import { HttpError } from "../http/validate";

// `reconnectId`: the connection the person clicked Reconnect on, renewed when the provider
// returns that same account (docs/adr/google-published-and-accounts.md).
export interface PendingConnectFlow { readonly connectorId: string; readonly accountLabel: string; readonly codeVerifier: string; readonly reconnectId?: string }
export function createPendingConnectStore(now: () => number, limits = { perUser: 5, total: 1000 }) {
  const flows = new Map<string, { userId: string; sessionId: string; expiry: number; flow: PendingConnectFlow }>();
  const key = (state: string) => createHash("sha256").update(state).digest("hex");
  function prune() { for (const [id, flow] of flows) if (flow.expiry <= now()) flows.delete(id); }
  return {
    put(userId: string, sessionId: string, state: string, flow: PendingConnectFlow) {
      prune();
      if (flows.size >= limits.total || [...flows.values()].filter((f) => f.userId === userId).length >= limits.perUser) {
        throw new HttpError(429, "Too many pending connections. Try again later.");
      }
      if (flows.has(key(state))) throw new Error("Duplicate pending connection");
      flows.set(key(state), { userId, sessionId, expiry: now() + 600_000, flow });
    },
    take(userId: string, sessionId: string, state: string): PendingConnectFlow | null {
      prune();
      const entry = flows.get(key(state));
      if (!entry || entry.userId !== userId || entry.sessionId !== sessionId) return null;
      flows.delete(key(state));
      return entry.flow;
    },
  };
}

export function pendingConnects() {
  return processSingleton("connectors.pending", () => createPendingConnectStore(() => systemClock.now().getTime()));
}
