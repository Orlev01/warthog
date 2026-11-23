// E05-S04 — the web app manifest (public/manifest.webmanifest).
//
// Acceptance criterion under test: "The manifest declares standalone display,
// name, theme and icons and returns valid JSON on GET."
//
// Files under public/ are served verbatim by Next at the site root, so a GET of
// /manifest.webmanifest returns exactly these bytes. We therefore read the
// served file and assert on its *parsed* content (behaviour), not its source
// text. The implementation is intentionally absent, so these tests fail (RED)
// until public/manifest.webmanifest exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MANIFEST_URL = new URL("../../public/manifest.webmanifest", import.meta.url);

function readManifestText(): string {
  // readFileSync throws ENOENT until the manifest is created — that is the RED.
  return readFileSync(MANIFEST_URL, "utf8");
}

function parseManifest(): Record<string, unknown> {
  const parsed = JSON.parse(readManifestText()) as unknown;
  assert.ok(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    "the manifest must be a JSON object",
  );
  return parsed as Record<string, unknown>;
}

test("GET /manifest.webmanifest returns valid JSON (an object)", () => {
  // JSON.parse throws if the served bytes are not valid JSON — valid-JSON-on-GET.
  const manifest = parseManifest();
  assert.equal(typeof manifest, "object");
});

test("the manifest declares standalone display", () => {
  const manifest = parseManifest();
  assert.equal(manifest.display, "standalone");
});

test("the manifest declares a (Warthog) name", () => {
  const manifest = parseManifest();
  assert.equal(typeof manifest.name, "string", "name must be a string");
  const name = manifest.name as string;
  assert.ok(name.trim().length > 0, "name must be non-empty");
  assert.match(name, /warthog/i, "the name identifies the product (Warthog)");
});

test("the manifest declares a theme colour as a hex value", () => {
  const manifest = parseManifest();
  assert.equal(typeof manifest.theme_color, "string", "theme_color must be a string");
  assert.match(
    manifest.theme_color as string,
    /^#([0-9a-f]{3}|[0-9a-f]{6})$/i,
    "theme_color must be a hex colour",
  );
});

test("the manifest declares icons, each with a src and sizes", () => {
  const manifest = parseManifest();
  assert.ok(Array.isArray(manifest.icons), "icons must be an array");
  const icons = manifest.icons as Array<Record<string, unknown>>;
  assert.ok(icons.length > 0, "icons must not be empty");
  for (const icon of icons) {
    assert.equal(typeof icon.src, "string", "each icon declares a src path");
    assert.ok((icon.src as string).length > 0, "each icon src is non-empty");
    assert.equal(typeof icon.sizes, "string", "each icon declares its sizes");
  }
});

test("the icon set covers the home-screen install sizes (192 and 512)", () => {
  // Android/iOS home-screen install needs 192px and 512px icons (brief: the
  // portal installs to the home screen on iOS and Android).
  const manifest = parseManifest();
  const icons = manifest.icons as Array<Record<string, unknown>>;
  const sizes = icons.map((i) => String(i.sizes ?? ""));
  assert.ok(
    sizes.some((s) => s.includes("192x192")),
    "an icon of size 192x192 is declared",
  );
  assert.ok(
    sizes.some((s) => s.includes("512x512")),
    "an icon of size 512x512 is declared",
  );
});

// UI/UX audit 2026-11-23 W-19: the manifest still carried the retired indigo (#4338ca) as the
// installed app's theme colour. It now matches the light theme colour the pages declare.
test("the installed app's theme colour is the current light theme colour, not the retired indigo", () => {
  const manifest = JSON.parse(readManifestText());
  assert.equal(manifest.theme_color, "#ffffff");
  assert.notEqual(String(manifest.theme_color).toLowerCase(), "#4338ca");
});
