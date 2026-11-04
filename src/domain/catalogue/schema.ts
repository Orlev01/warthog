// E03-S11 — Connector catalogue schema.
//
// The catalogue is a set of DATA FILES authored by the operator (design §7:
// `catalogue/connectors/<id>.yaml`; "Adding an entry = a PR + deploy; no code
// change"). This module is the zod schema for ONE catalogue entry plus a safe
// (non-throwing) validator a boot loader uses to reject bad entries at startup.
//
// Pure domain module (CLAUDE.md / conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). Validating an entry is a pure function of
// its input. Keys are snake_case because they mirror the YAML files' native keys.

import { z } from "zod";

// The auth-detail block an entry carries (design §7). Its fields vary by kind:
//   - oauth2:        authorize_url / token_url / scopes
//   - api_key|basic: a header template
//   - provider_mcp:  none (Warthog self-registers via CIMD → an empty object is valid)
// Every field is optional so each kind supplies only the ones it needs; `scopes`,
// when present, must be a list of strings.
const authDetailsSchema = z.object({
  authorize_url: z.string().optional(),
  token_url: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  header: z.string().optional(),
});

// An optional request descriptor used to verify a connection works: a path
// (relative to `base_url`) and an optional HTTP method.
const verifySchema = z.object({
  path: z.string().min(1),
  method: z.string().optional(),
});

// A curated tool exposed for the connector — at least a name.
const curatedToolSchema = z.object({
  name: z.string().min(1),
});

// The zod schema for one catalogue entry (a connector). Exported so a boot loader
// (a later task) can validate every data file against it.
export const catalogueEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  category: z.string().min(1),
  auth_kind: z.enum(["oauth2", "api_key", "basic", "provider_mcp"]),
  // The general request tool's paths are relative to `base_url` and the host can't
  // be overridden, so it must be a real URL.
  base_url: z.url(),
  auth: authDetailsSchema,
  instructions: z.string().optional(),
  verify: verifySchema.optional(),
  curated_tools: z.array(curatedToolSchema).optional(),
  google_early_access: z.boolean().optional(),
});

export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>;

// The entry validator — a safe (non-throwing) wrapper over the schema. On a
// well-formed entry it returns the parsed value; on a malformed entry it returns
// FIELD-LEVEL errors (each issue's `path` names the offending field).
export function validateCatalogueEntry(
  input: unknown,
):
  | { ok: true; entry: CatalogueEntry }
  | { ok: false; issues: { path: (string | number)[]; message: string }[] } {
  const result = catalogueEntrySchema.safeParse(input);
  if (result.success) {
    return { ok: true, entry: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((segment) =>
        typeof segment === "symbol" ? segment.toString() : segment,
      ),
      message: issue.message,
    })),
  };
}
