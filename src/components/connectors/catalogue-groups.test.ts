import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CATALOGUE_CATEGORY_GROUPS,
  catalogueGroupLabel,
  catalogueGroupOf,
  compareCatalogueGroups,
  resolveCatalogueGroup,
} from "./catalogue-groups";

// The operator's catalogue data (rooted at the working directory, as the page loads it).
const DATA = join(process.cwd(), "catalogue", "connectors");
const dataCategories = [
  ...new Set(
    readdirSync(DATA)
      .filter((f) => f.endsWith(".json"))
      .map((f) => String(JSON.parse(readFileSync(join(DATA, f), "utf8")).category)),
  ),
];

test("every category in the catalogue data folds into one plain display group", () => {
  const keys = new Set(CATALOGUE_CATEGORY_GROUPS.map((g) => g.key));
  for (const category of dataCategories) {
    assert.ok(keys.has(catalogueGroupOf(category)), `"${category}" is folded into a listed group`);
  }
  const seen = CATALOGUE_CATEGORY_GROUPS.flatMap((g) => g.includes);
  assert.equal(new Set(seen).size, seen.length, "no data category sits in two groups");
  assert.ok(CATALOGUE_CATEGORY_GROUPS.length <= 16, "about fifteen groups, not thirty-four");
});

test("near-duplicates share a group, and labels are plain words", () => {
  assert.equal(catalogueGroupOf("storage"), catalogueGroupOf("file-storage"));
  assert.equal(catalogueGroupOf("flight"), catalogueGroupOf("travel"));
  assert.equal(catalogueGroupOf("iot"), "smart-home");
  assert.equal(catalogueGroupLabel("files"), "Files and storage");
  assert.equal(catalogueGroupLabel("brand-new-thing"), "Brand new thing", "an unlisted slug still reads as words");
  for (const group of CATALOGUE_CATEGORY_GROUPS) assert.doesNotMatch(group.label, /\b(CRM|IoT)\b/);
});

test("everyday groups sort first; a category link resolves to its group or is ignored", () => {
  assert.deepEqual(["developer-tools", "email", "zz-new", "calendar"].sort(compareCatalogueGroups), ["email", "calendar", "developer-tools", "zz-new"]);
  const available = new Set(["files", "email"]);
  assert.equal(resolveCatalogueGroup("files", available), "files");
  assert.equal(resolveCatalogueGroup("file-storage", available), "files", "a link from before the grouping still lands");
  assert.equal(resolveCatalogueGroup("travel", available), null, "a group with nothing in this catalogue is ignored");
  assert.equal(resolveCatalogueGroup("<script>", available), null);
  assert.equal(resolveCatalogueGroup(undefined, available), null);
});
