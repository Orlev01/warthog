import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { withTransaction, type Db } from "../db/index";
import { encrypt, decrypt } from "../crypto/envelope";
import {
  createConnection,
  getConnectionCredentials,
  getConnectionById,
  updateConnectionCredentials,
  updateConnectionStatus,
  type Connection,
} from "../db/connections";
import { createRedactingRecorder } from "../mcp/recorder";
import type { ConnectorToolDeclaration } from "../mcp/tools/registry";
import type { Session } from "../auth/session";
import type { Clock } from "../seams/clock";
import type { CatalogueIndex } from "./catalogue";
import { HttpError, parseParams } from "../http/validate";
import {
  createGuardedMcpFetch,
  startProviderAuthorization,
  finishProviderAuthorization,
  discoverProviderTools,
  useProviderClient,
  type ProviderState,
} from "./provider-client";

export interface ProviderFlow {
  connectorId: string;
  accountLabel: string;
  codeVerifier: string;
  providerState: ProviderState;
  reconnectId?: string;
}
const hash = (state: string) =>
  createHash("sha256").update(state).digest("hex");
const FLOW_TABLE = "provider_mcp_flows";
export const providerArgumentsSchema = z
  .object({
    arguments: z.record(z.string(), z.unknown()).default({}),
    reason: z.string().max(2000).optional(),
  })
  .refine(
    (v) => Buffer.byteLength(JSON.stringify(v)) <= 64_000,
    "Provider arguments are too large",
  );

export function createProviderRuntime(deps: {
  db: Db;
  catalogue: CatalogueIndex;
  clock: Clock;
  publicBaseUrl: string;
  dekFor: (userId: string) => Promise<Uint8Array>;
  fetch?: typeof fetch;
}) {
  const { db, clock, publicBaseUrl } = deps;
  const request = deps.fetch ?? createGuardedMcpFetch();
  function entryFor(id: string) {
    const entry = deps.catalogue.get(id);
    if (!entry || entry.auth_kind !== "provider_mcp")
      throw new HttpError(400, "Unknown provider MCP service.");
    return entry;
  }
  const settings = (id: string) => ({
    serverUrl: entryFor(id).base_url,
    publicBaseUrl,
  });
  return {
    async begin(
      session: Session,
      connectorId: string,
      reconnectId?: string,
    ): Promise<{ url: string }> {
      const entry = entryFor(connectorId),
        dek = await deps.dekFor(session.userId);
      const existing = reconnectId
        ? await getConnectionById(db, session.userId, reconnectId)
        : null;
      if (reconnectId && (!existing || existing.connectorId !== connectorId))
        throw new HttpError(404, "Service connection not found.");
      const state = randomBytes(32).toString("base64url"),
        providerState: ProviderState = {};
      const url = await startProviderAuthorization(
        { ...settings(connectorId), state },
        providerState,
        request,
      );
      const id = randomUUID();
      const flow: ProviderFlow = {
        connectorId,
        accountLabel: existing?.accountLabel ?? entry.name,
        codeVerifier: "",
        providerState,
        ...(reconnectId ? { reconnectId } : {}),
      };
      const payload = await encrypt(
        dek,
        FLOW_TABLE,
        "payload",
        id,
        JSON.stringify(flow),
      );
      await withTransaction(db, async (tx) => {
        await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
          session.userId,
        ]);
        await tx.query(
          "DELETE FROM provider_mcp_flows WHERE expires_at <= $1",
          [clock.now().toISOString()],
        );
        const counts = await tx.query(
          "SELECT count(*) AS total, count(*) FILTER (WHERE user_id = $1) AS own FROM provider_mcp_flows",
          [session.userId],
        );
        if (
          Number(counts.rows[0]?.own) >= 5 ||
          Number(counts.rows[0]?.total) >= 1000
        )
          throw new HttpError(
            429,
            "Too many pending connections. Try again later.",
          );
        await tx.query(
          "INSERT INTO provider_mcp_flows (id,user_id,session_id,state_hash,payload,expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            id,
            session.userId,
            session.id,
            hash(state),
            payload,
            new Date(clock.now().getTime() + 600_000).toISOString(),
          ],
        );
      });
      return { url };
    },
    async take(
      userId: string,
      sessionId: string,
      state: string,
    ): Promise<ProviderFlow | null> {
      const row = (
        await db.query(
          "DELETE FROM provider_mcp_flows WHERE user_id = $1 AND session_id = $2 AND state_hash = $3 AND expires_at > $4 RETURNING id,payload",
          [userId, sessionId, hash(state), clock.now().toISOString()],
        )
      ).rows[0];
      if (!row) return null;
      const dek = await deps.dekFor(userId);
      return JSON.parse(
        await decrypt(
          dek,
          FLOW_TABLE,
          "payload",
          row.id as string,
          row.payload as string,
        ),
      ) as ProviderFlow;
    },
    async complete(
      input: ProviderFlow & {
        userId: string;
        state: string;
        code: string;
        iss?: string;
      },
    ): Promise<Connection> {
      const state = input.providerState,
        entry = entryFor(input.connectorId),
        config = settings(entry.id);
      await finishProviderAuthorization(
        { ...config, code: input.code, iss: input.iss },
        state,
        request,
      );
      state.tools = await discoverProviderTools(
        config,
        state,
        request,
        async () => {},
      );
      const dek = await deps.dekFor(input.userId);
      return withTransaction(db, async (tx) => {
        let connection: Connection;
        const credentials = { providerMcp: state };
        if (input.reconnectId) {
          await tx.query(
            "SELECT id FROM connections WHERE user_id = $1 AND id = $2 FOR UPDATE",
            [input.userId, input.reconnectId],
          );
          const existing = await getConnectionById(
            tx,
            input.userId,
            input.reconnectId,
          );
          if (!existing || existing.connectorId !== entry.id)
            throw new HttpError(404, "Service connection not found.");
          await updateConnectionCredentials(
            tx,
            { userId: input.userId, id: existing.id, credentials },
            dek,
          );
          connection = await updateConnectionStatus(tx, {
            userId: input.userId,
            id: existing.id,
            status: "connected",
          });
        } else
          connection = await createConnection(
            tx,
            {
              userId: input.userId,
              connectorId: entry.id,
              accountLabel: input.accountLabel,
              credentials,
            },
            dek,
            clock,
          );
        await createRedactingRecorder({
          db: tx,
          clock,
          dekFor: async () => dek,
        }).record({
          userId: input.userId,
          kind: "connection_change",
          source: "warthog",
          connectorId: entry.id,
          outcome: input.reconnectId ? "reconnected" : "connected",
          payload: { service: entry.name, connectionId: connection.id },
        });
        return connection;
      });
    },
    async toolsets(
      userId: string,
      connections: readonly Pick<Connection, "id" | "connectorId" | "status">[],
    ): Promise<Record<string, readonly ConnectorToolDeclaration[]>> {
      const result: Record<string, readonly ConnectorToolDeclaration[]> = {};
      const dek = await deps.dekFor(userId);
      for (const connection of connections) {
        if (
          connection.status !== "connected" ||
          deps.catalogue.get(connection.connectorId)?.auth_kind !==
            "provider_mcp"
        )
          continue;
        const state = (
          await getConnectionCredentials(db, userId, connection.id, dek)
        )?.providerMcp as ProviderState | undefined;
        result[connection.id] = (state?.tools ?? []).map((tool) => ({
          name: tool.name,
          description: `${tool.description ?? tool.name}\nPass the provider's fields in arguments. Provider schema: ${JSON.stringify(tool.inputSchema)}`,
          makesChange: true,
          requiresApproval: true,
          schema: providerArgumentsSchema,
        }));
      }
      return result;
    },
    async execute(
      userId: string,
      connectionId: string,
      tool: string,
      input: unknown,
    ): Promise<unknown> {
      const parsed = parseParams(providerArgumentsSchema, input),
        dek = await deps.dekFor(userId);
      // Serialize refresh-token rotation for this connection across requests.
      const outcome = await withTransaction(db, async (tx) => {
        await tx.query(
          "SELECT id FROM connections WHERE user_id = $1 AND id = $2 FOR UPDATE",
          [userId, connectionId],
        );
        const connection = await getConnectionById(tx, userId, connectionId);
        if (!connection || connection.status !== "connected")
          throw new HttpError(409, "Reconnect this service.");
        const state = (
          await getConnectionCredentials(tx, userId, connectionId, dek)
        )?.providerMcp as ProviderState | undefined;
        if (!state?.tokens || !state.tools?.some((t) => t.name === tool))
          throw new HttpError(
            409,
            "Reconnect this service to refresh its tools.",
          );
        const save = () =>
          updateConnectionCredentials(
            tx,
            { userId, id: connectionId, credentials: { providerMcp: state } },
            dek,
          ).then(() => {});
        try {
          const value = await useProviderClient(
            settings(connection.connectorId),
            state,
            request,
            save,
            (client) =>
              client.callTool(
                { name: tool, arguments: parsed.arguments },
                { timeout: 15_000 },
              ),
          );
          return { ok: true as const, value };
        } catch (error) {
          // A failed tool call must not roll back an already rotated refresh token.
          await save();
          if (!state.tokens)
            await updateConnectionStatus(tx, {
              userId,
              id: connectionId,
              status: "needs_reconnect",
            });
          return { ok: false as const, error };
        }
      });
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
  };
}
