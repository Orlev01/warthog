// "Build my profile" as an MCP prompt (docs/adr/profile-build.md): an agent that may save
// records offers the person the same fixed text Home gives them; any other agent has no prompt.
// Driven over the composed dispatch, with an isolated PGlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch, PROFILE_PROMPT_NAME } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import type { PermissionGrants } from "../db/agent-permissions";
import { PROFILE_PROMPT } from "../../domain/life-admin/profile-skill";
import { freshDb } from "../../test/db";
import { mcpRequest } from "../../test/mcp-request";
import { grantServices } from "../../test/grants";
import type { Db } from "../db/index";

const NOW = new Date("2026-11-24T00:00:00.000Z");

function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: Buffer.alloc(48, 0x2a).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 0x5c).toString("base64"),
  } as NodeJS.ProcessEnv);
}

async function seed(db: Db, config: Config, grants: Partial<PermissionGrants>): Promise<string> {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
  const connectionId = randomUUID();
  await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
  await grantServices(db, {
    userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: true,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false,
    rulesScope: [], rateLimit: 120, ...grants,
  });
  return connectionId;
}

async function rpc(res: Response): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
  const text = await res.text();
  const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  return JSON.parse(frames.length > 0 ? frames[frames.length - 1]! : text);
}

const post = (body: unknown) => mcpRequest(body, { url: "https://warthog.example/mcp" });

test("an agent that may save records is offered the Build my profile prompt, with Home's exact text", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const connectionId = await seed(db, config, { recordsAccess: true });
    const dispatch = createMcpDispatch({ db, config });
    const listed = await rpc(await dispatch(connectionId, post({ jsonrpc: "2.0", id: 1, method: "prompts/list", params: {} })));
    const prompts = (listed.result?.prompts ?? []) as { name: string; title?: string }[];
    assert.deepEqual(prompts.map((prompt) => [prompt.name, prompt.title]), [[PROFILE_PROMPT_NAME, "Build my profile"]]);
    const got = await rpc(await dispatch(connectionId, post({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: PROFILE_PROMPT_NAME } })));
    const messages = (got.result?.messages ?? []) as { role: string; content: { type: string; text: string } }[];
    assert.deepEqual(messages, [{ role: "user", content: { type: "text", text: PROFILE_PROMPT } }]);
  } finally {
    await db.close();
  }
});

test("an agent that can't save records has no profile prompt", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    for (const grants of [{ recordsAccess: false }, { recordsAccess: true, resourceControls: { recordsWrite: false } }] as const) {
      const connectionId = await seed(db, config, grants as Partial<PermissionGrants>);
      const dispatch = createMcpDispatch({ db, config });
      const listed = await rpc(await dispatch(connectionId, post({ jsonrpc: "2.0", id: 1, method: "prompts/list", params: {} })));
      const prompts = (listed.result?.prompts ?? []) as { name: string }[];
      assert.ok(!prompts.some((prompt) => prompt.name === PROFILE_PROMPT_NAME), JSON.stringify(grants));
      const got = await rpc(await dispatch(connectionId, post({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: PROFILE_PROMPT_NAME } })));
      assert.ok(got.error, "asking for it by name is refused");
    }
  } finally {
    await db.close();
  }
});
