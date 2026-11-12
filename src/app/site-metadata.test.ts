// Review fix G4 — the PWA is installable: the root metadata links the web app manifest,
// declares the icons and the iOS standalone tags, and every icon the manifest names is a
// real PNG of its declared size in public/.
//
// Before this fix the root layout's metadata had only a title and description: no
// <link rel="manifest">, no icons and no apple-mobile-web-app tags, while the manifest
// named three icon files that did not exist. Chrome/Android never offered install and iOS
// "Add to Home Screen" made a Safari bookmark, so iOS web push (which needs an installed
// web app) was impossible.
//
// The metadata lives in `site-metadata.ts` (layout.tsx re-exports it) because layout.tsx
// imports the global stylesheet and next/font, which only load under Next's bundler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { SITE_METADATA, SITE_VIEWPORT } from "./site-metadata";

const PUBLIC = join(process.cwd(), "public");

// A PNG's width/height from its IHDR chunk (bytes 16–23), after checking the signature.
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function publicPath(src: string): string {
  return join(PUBLIC, src.replace(/^\//, ""));
}

test("the root metadata links the web app manifest that public/ serves", () => {
  assert.equal(SITE_METADATA.manifest, "/manifest.webmanifest");
  assert.ok(existsSync(publicPath("/manifest.webmanifest")));
});

test("the root metadata declares icons (incl. an apple-touch-icon) that exist at their declared sizes", () => {
  const icons = SITE_METADATA.icons as { icon: Array<{ url: string; sizes: string }>; apple: Array<{ url: string; sizes: string }> };
  const all = [...icons.icon, ...icons.apple];
  assert.ok(icons.apple.length >= 1, "an apple-touch-icon is declared for iOS home screens");
  for (const icon of all) {
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(publicPath(icon.url)), { width: w, height: h }, icon.url);
  }
});

test("iOS standalone launch is declared (apple-mobile-web-app-capable) with the app's title", () => {
  const apple = SITE_METADATA.appleWebApp as { capable: boolean; title: string };
  assert.equal(apple.capable, true);
  assert.match(apple.title, /warthog/i);
});

test("every icon the manifest names is a real PNG of its declared size, covering 192, 512 and maskable", () => {
  const manifest = JSON.parse(readFileSync(publicPath("/manifest.webmanifest"), "utf8")) as {
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  for (const icon of manifest.icons) {
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(publicPath(icon.src)), { width: w, height: h }, icon.src);
  }
  assert.ok(manifest.icons.some((i) => i.sizes === "192x192"));
  assert.ok(manifest.icons.some((i) => i.sizes === "512x512" && (i.purpose ?? "any").includes("any")));
  assert.ok(manifest.icons.some((i) => (i.purpose ?? "").includes("maskable")));
});

test("the browser theme colour follows the light and dark page backgrounds", () => {
  const themes = SITE_VIEWPORT.themeColor as Array<{ media: string; color: string }>;
  assert.ok(themes.some((t) => /light/.test(t.media)));
  assert.ok(themes.some((t) => /dark/.test(t.media)));
});

test("the browser tab has a small icon and a favicon.ico from the Warthog logo", () => {
  const icons = SITE_METADATA.icons as { icon: Array<{ url: string; sizes: string }> };
  const small = icons.icon.find((icon) => icon.sizes === "32x32");
  assert.ok(small, "a 32x32 tab icon is declared");
  assert.deepEqual(pngSize(publicPath(small!.url)), { width: 32, height: 32 });
  assert.equal(icons.icon[0]!.sizes, "32x32", "the tab-sized icon is listed first");
  assert.ok(existsSync(publicPath("/favicon.ico")), "a favicon.ico is served for browsers that ask for it");
});
