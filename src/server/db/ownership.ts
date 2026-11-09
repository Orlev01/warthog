import { Client } from "pg";
import type { Config } from "../config";
import { processSingleton } from "../seams/process-singleton";

export interface OwnershipClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<unknown>;
  on(event: "error" | "end", callback: () => void): unknown;
}

export async function acquireOwnership(deps: {
  client: OwnershipClient;
  onLost: () => void;
  schedule: (poll: () => Promise<void>) => () => void;
}): Promise<{ close(): Promise<void> }> {
  let owned = false, closing = false, polling = false;
  let cancel = () => {};
  function lost() {
    if (!owned || closing) return;
    owned = false; cancel(); deps.onLost();
  }
  deps.client.on("error", lost);
  deps.client.on("end", lost);
  try {
    await deps.client.connect();
    const result = await deps.client.query("SELECT pg_try_advisory_lock(1463898708, 1) AS acquired");
    if (result.rows[0]?.acquired !== true) {
      await deps.client.end();
      throw new Error("Warthog database is already owned by another application instance");
    }
  } catch (error) {
    await deps.client.end().catch(() => {});
    if (error instanceof Error && error.message === "Warthog database is already owned by another application instance") throw error;
    throw new Error("Warthog database ownership could not be established");
  }
  owned = true;
  cancel = deps.schedule(async () => {
    if (!owned || polling) return;
    polling = true;
    try { await deps.client.query("SELECT 1"); }
    catch { lost(); }
    finally { polling = false; }
  });
  return { async close() { closing = true; owned = false; cancel(); await deps.client.end(); } };
}

export async function startProductionOwnership(config: Config): Promise<void> {
  if (config.nodeEnv !== "production") return;
  const holder = processSingleton<{ startup?: Promise<unknown> }>("database.ownership", () => ({}));
  holder.startup ??= acquireOwnership({
    client: new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000,
      query_timeout: 5000, statement_timeout: 5000, keepAlive: true, application_name: "warthog-ownership" }),
    onLost: () => {
      // No graceful drain after losing ownership: it could release in-memory data
      // while a replacement owns the database. The OS closes all connections.
      console.error("[warthog] database ownership lost; terminating");
      process.exit(1);
    },
    schedule: (poll) => {
      const timer = setInterval(() => { void poll(); }, 2000);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
  await holder.startup;
}
