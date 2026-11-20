// Curated LinkedIn tools (docs/adr/linkedin-connector.md; design §7 "Connector engine").
//
// LinkedIn's self-serve products give an app two things: the member's own sign-in profile
// ("Sign In with LinkedIn using OpenID Connect": name, email, photo) and posting as them
// ("Share on LinkedIn", w_member_social). Reading a feed, connections, messages or profile
// details needs LinkedIn partner programmes Warthog isn't in, so there are exactly three tools:
//
//   • profile      — a read: the member's name, email and photo.
//   • create_post  — a change: a post Warthog builds from plain fields, so the approval card
//                    shows exactly what goes out; it always asks the person first (tool
//                    routing declares it), whatever the agent may do alone.
//   • delete_post  — a change, and create_post's declared reversal, so Undo works.
//
// The transport is the connector engine's own `sendConnectorRequest`: member-scoped credential
// read, the entry's host only (`base_url`, never a caller value), Bearer presentation, timeout
// and truncation. This module adds the declarations, the per-tool requests and LinkedIn's
// version headers. A connection that needs reconnecting, or isn't the session user's, sends
// nothing. No `process.env`, no ambient secret (INV-103).

import { getConnectionById } from "../../db/connections";
import { cleanShortText } from "../../../domain/content/untrusted";
import { HttpError } from "../../http/validate";
import { sendConnectorRequest, type ConnectorRequestInput } from "../request-tool";
import {
  LinkedInPostError,
  buildLinkedInPost,
  isLinkedInPostUrn,
  postUrl,
  type LinkedInPostInput,
} from "../../../domain/content/linkedin-post";
import type { CuratedTool, CuratedToolCallInput, CuratedToolDeps, CuratedToolResult } from "./google";

// The LinkedIn API version every versioned call names (YYYYMM). LinkedIn supports a version
// for at least a year after release; move it forward before that lapses.
// https://learn.microsoft.com/en-us/linkedin/marketing/versioning
export const LINKEDIN_VERSION = "202611";
const VERSIONED = { "LinkedIn-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0" } as const;

export const LINKEDIN_CURATED_TOOLS: readonly CuratedTool[] = [
  { name: "linkedin__profile", connectorId: "linkedin", makesChange: false, sendsMessage: false },
  { name: "linkedin__create_post", connectorId: "linkedin", makesChange: true, sendsMessage: false, reversalTool: "linkedin__delete_post" },
  { name: "linkedin__delete_post", connectorId: "linkedin", makesChange: true, sendsMessage: false },
];
const NAMES = new Set(LINKEDIN_CURATED_TOOLS.map((tool) => tool.name));

function ok(result: CuratedToolResult): boolean {
  return result.status >= 200 && result.status < 300;
}

// The member's sign-in profile, which also names them for a post (`sub`).
async function userinfo(base: Pick<ConnectorRequestInput, "entry" | "userId" | "connectionId" | "dek">, deps: CuratedToolDeps) {
  const result = await sendConnectorRequest({ ...base, method: "GET", path: "/v2/userinfo" }, deps);
  let profile: Record<string, unknown> = {};
  if (ok(result)) {
    try {
      const parsed: unknown = JSON.parse(result.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) profile = parsed as Record<string, unknown>;
    } catch {
      profile = {};
    }
  }
  return { result, profile };
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * How a LinkedIn connection is named: the member's email, or their name when LinkedIn gives no
 * email (it's optional in the sign-in profile, e.g. for a member who signed up by phone).
 */
export function linkedInAccountLabel(profile: { email?: unknown; name?: unknown }): string {
  const email = text(profile.email)?.trim();
  if (email && email.includes("@") && email.length <= 256) return email;
  const name = cleanShortText((text(profile.name) ?? "").replace(/\s+/g, " "), 120).trim();
  return name || "LinkedIn account";
}

/** Call one curated LinkedIn tool through the person's LinkedIn connection. */
export async function callLinkedInTool(input: CuratedToolCallInput, deps: CuratedToolDeps): Promise<CuratedToolResult> {
  if (!NAMES.has(input.tool)) throw new HttpError(400, "unknown curated tool");
  const connection = await getConnectionById(deps.db, input.userId, input.connectionId);
  if (!connection) throw new HttpError(404, "connection not found");
  if (connection.status !== "connected") throw new HttpError(409, "connection needs reconnecting");
  const base = { entry: input.entry, userId: input.userId, connectionId: input.connectionId, dek: input.dek };

  if (input.tool === "linkedin__profile") {
    const { result, profile } = await userinfo(base, deps);
    if (!ok(result)) return result;
    const shown = {
      name: text(profile.name), givenName: text(profile.given_name), familyName: text(profile.family_name),
      email: text(profile.email), emailVerified: profile.email_verified === true, picture: text(profile.picture),
    };
    return { status: result.status, body: JSON.stringify(shown), truncated: false };
  }

  if (input.tool === "linkedin__create_post") return createPost(input.post, base, deps);

  const id = input.query?.id ?? "";
  if (!isLinkedInPostUrn(id)) throw new HttpError(400, "query.id must be a post id from create_post, like urn:li:share:123.");
  return sendConnectorRequest({
    ...base, method: "DELETE", path: `/rest/posts/${encodeURIComponent(id)}`, headers: { ...VERSIONED, "X-RestLi-Method": "DELETE" },
  }, deps);
}

async function createPost(post: LinkedInPostInput | undefined, base: Pick<ConnectorRequestInput, "entry" | "userId" | "connectionId" | "dek">, deps: CuratedToolDeps): Promise<CuratedToolResult> {
  if (!post) throw new HttpError(400, "Give the post's text.");
  // Build it once with a stand-in id first, so a post Warthog won't send is refused before
  // anything reaches LinkedIn.
  try {
    buildLinkedInPost("check", post);
  } catch (err) {
    if (err instanceof LinkedInPostError) throw new HttpError(400, err.message);
    throw err;
  }
  const { result: profileResult, profile } = await userinfo(base, deps);
  if (!ok(profileResult)) return profileResult;
  let body: Record<string, unknown>;
  try {
    body = buildLinkedInPost(text(profile.sub) ?? "", post);
  } catch (err) {
    if (err instanceof LinkedInPostError) throw new HttpError(502, err.message);
    throw err;
  }
  const result = await sendConnectorRequest({
    ...base, method: "POST", path: "/rest/posts", body: JSON.stringify(body), contentType: "application/json",
    headers: VERSIONED, readHeader: "x-restli-id",
  }, deps);
  if (!ok(result)) return { status: result.status, body: result.body, truncated: result.truncated };
  const visibility = body.visibility;
  const id = result.header;
  const shown = id && isLinkedInPostUrn(id) ? { id, url: postUrl(id), visibility } : { posted: true, visibility };
  return { status: result.status, body: JSON.stringify(shown), truncated: false };
}
