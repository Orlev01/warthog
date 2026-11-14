// The public page entries on a deployment whose front door has its own host
// (docs/adr/website-root-domain.md): each entry passes the configured links to its view,
// names its canonical address on the website, and the root metadata and the public 404 match
// the host they are served on. The views themselves are covered by
// src/components/public/website-links.test.tsx; this file covers the entries' wiring.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { Metadata } from "next";

import { withPageRequest } from "@/test/page-request";
import { AuthScreen } from "@/components/auth/auth-screen";
import AuthLayout from "./(auth)/layout";
import { generateMetadata as homeMetadata } from "./page";
import HelpPage, { generateMetadata as helpMetadata } from "./help/page";
import CompatibilityPage, { generateMetadata as compatibilityMetadata } from "./help/compatibility/page";
import PrivacyPage, { generateMetadata as privacyMetadata } from "./privacy/page";
import TermsPage, { generateMetadata as termsMetadata } from "./terms/page";
import NotFound from "./not-found";
import { SITE_METADATA, rootMetadataFor } from "./site-metadata";

const APP = "https://app.warthog.example";
const WEBSITE = "https://warthog.example";

// The config module's minimal valid environment (the compatibility entry calls loadConfig).
const ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: APP,
  WEBAUTHN_RP_ID: "app.warthog.example",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
};

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T> | T): Promise<T> {
  const keys = [...new Set([...Object.keys(ENV), ...Object.keys(env), "ADMIN_BASE_URL", "WARTHOG_DEV_TOOLS"])];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function hrefs(markup: string): string[] {
  return [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)].map((m) => m[1]!);
}

test("every public entry passes the website's brand and the app's account links to its view", async () => {
  await withEnv(ENV, async () => {
    for (const [name, render] of [
      ["help", () => <HelpPage />],
      ["privacy", () => <PrivacyPage />],
      ["terms", () => <TermsPage />],
      ["compatibility", async () => CompatibilityPage({ searchParams: Promise.resolve({}) })],
    ] as const) {
      const links = hrefs(renderToStaticMarkup(await render()));
      assert.ok(links.includes(`${WEBSITE}/`), `${name}: the brand leads to the website`);
      for (const path of ["/signin", "/signup"]) assert.ok(links.includes(`${APP}${path}`), `${name}: ${path} on the app`);
      assert.ok(!links.some((href) => /^\/(signin|signup|recover|reset)\b/.test(href)), `${name}: no relative account link`);
    }
  });
});

test("the public pages name their website address as canonical on both hosts, and nothing without a website", async () => {
  const pages: Array<[string, () => Metadata]> = [
    ["/", homeMetadata], ["/help", helpMetadata], ["/help/compatibility", compatibilityMetadata],
    ["/privacy", privacyMetadata], ["/terms", termsMetadata],
  ];
  await withEnv(ENV, () => {
    for (const [path, metadata] of pages) assert.equal(metadata().alternates?.canonical, `${WEBSITE}${path}`, path);
    assert.equal(termsMetadata().title, "Terms of use", "a page keeps its own metadata");
    assert.match(String((homeMetadata().title as { absolute: string }).absolute), /Your rules/);
  });
  await withEnv({ ...ENV, PUBLIC_BASE_URL: "http://localhost:3000", WEBAUTHN_RP_ID: "localhost" }, () => {
    for (const [path, metadata] of pages) assert.equal(metadata().alternates, undefined, path);
  });
});

test("only the app host is offered as an installable app", async () => {
  await withEnv(ENV, () => {
    for (const host of ["warthog.example", "admin.warthog.example"]) {
      const metadata = rootMetadataFor(host);
      assert.equal(metadata.manifest, undefined, `${host}: no manifest link`);
      assert.equal(metadata.appleWebApp, undefined, `${host}: no iOS standalone tags`);
      assert.deepEqual(metadata.icons, SITE_METADATA.icons, `${host}: keeps the icons`);
      assert.equal(metadata.title, SITE_METADATA.title);
    }
    for (const host of ["app.warthog.example", null]) assert.equal(rootMetadataFor(host), SITE_METADATA, String(host));
  });
});

test("the public 404 leads home to the website, except on the admin host", async () => {
  await withEnv(ENV, async () => {
    for (const [host, home] of [["app.warthog.example", `${WEBSITE}/`], ["warthog.example", `${WEBSITE}/`], ["admin.warthog.example", "/"]] as const) {
      const markup = renderToStaticMarkup(await withPageRequest("/nope", undefined, () => NotFound(), { host }));
      assert.match(markup, /We couldn(&#x27;|')t find that page/, host);
      assert.equal(hrefs(markup).filter((href) => href === home).length, 2, `${host}: brand and Go to Warthog`);
    }
  });
});

test("the account screens' layout points their brand and Back to home at the website", async () => {
  await withEnv(ENV, () => {
    const markup = renderToStaticMarkup(<AuthLayout><AuthScreen title="Sign in">form</AuthScreen></AuthLayout>);
    assert.equal(hrefs(markup).filter((href) => href === `${WEBSITE}/`).length, 2, "brand and Back to home");
  });
});
