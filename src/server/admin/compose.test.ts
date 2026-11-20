// The admin page seams (src/server/admin/compose.ts): a requested service counts as in the
// catalogue only when that person can connect it, so a Google service settles a request only
// for someone on the early-access list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { loadCatalogue } from "../connectors/catalogue";
import { catalogueMatchFor } from "./compose";

const catalogue = loadCatalogue({ dir: join(process.cwd(), "catalogue", "connectors"), isOAuthClientConfigured: () => true });

test("a requested name matches a connectable entry by name or alias, and a Google entry only for someone on the list", () => {
  const match = catalogueMatchFor(catalogue, ["allowed@example.test"]);
  assert.equal(match("todoist", "anyone@example.test"), "Todoist");
  assert.equal(match("Google Mail", "allowed@example.test"), "Gmail", "an alias counts");
  assert.equal(match("Gmail", "ALLOWED@example.test"), "Gmail", "the list ignores case");
  assert.equal(match("Gmail", "stranger@example.test"), undefined, "not on the list, so they still can't connect it");
  assert.equal(match("Fax machine", "anyone@example.test"), undefined);
  assert.equal(match("LinkedIn", "anyone@example.test"), "LinkedIn", "LinkedIn settles requests once its app is configured");
});

test("an oauth2 entry without its client configured isn't offered, so it settles nothing", () => {
  const unconfigured = loadCatalogue({ dir: join(process.cwd(), "catalogue", "connectors"), isOAuthClientConfigured: () => false });
  assert.equal(catalogueMatchFor(unconfigured, ["allowed@example.test"])("Gmail", "allowed@example.test"), undefined);
  assert.equal(catalogueMatchFor(unconfigured, [])("LinkedIn", "anyone@example.test"), undefined, "LinkedIn ships dark");
});
