/**
 * Next.js configuration. Routes live under `src/app`.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Next's dev server evaluates code with eval and talks to its HMR websocket; the production
// build needs neither. (Read here because next.config is evaluated by the framework itself,
// before the app's config module exists.)
const isDev = process.env.NODE_ENV !== "production";

// The Content-Security-Policy: every fetch directive defaults to the app's own origin, so an
// injected script can load no code from elsewhere and send nothing off-site (fetch, images,
// fonts, frames, workers). Next's App Router bootstraps with inline scripts and React sets
// inline styles, so script-src/style-src keep 'unsafe-inline' — a per-request nonce policy is
// the follow-up that would also block inline script. Framing, plugins, <base> hijacking and
// cross-site form posts stay forbidden.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// Sent on every response.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A self-contained server (.next/standalone) for the container image.
  output: "standalone",
  outputFileTracingRoot: projectRoot,
  // PGlite (dev/test database) loads WASM from node_modules at runtime and the Azure SDKs load
  // optional modules dynamically — bundling breaks both, so Node requires them directly.
  serverExternalPackages: [
    "pg",
    "@electric-sql/pglite",
    "@azure/identity",
    "@azure/keyvault-keys",
    "@azure/storage-blob",
    "@azure/communication-email",
    "@azure/communication-sms",
  ],
  outputFileTracingExcludes: { "*": ["node_modules/@electric-sql/pglite/**"] },
  // The migration runner reads db/migrations from the app root at first use (getServerDb), so the
  // SQL files ship inside the standalone server.
  outputFileTracingIncludes: { "/**": ["./db/migrations/*.sql"] },
  experimental: {
    // Receipts (life-admin, up to 25 MiB) and data imports (settings/data, up to 16 MiB) upload
    // through Server Actions, and Next's 1 MB default refuses them before the app's own limits
    // and plain-words errors can apply. 26 MB leaves room for the largest file plus its
    // multipart framing; Next still enforces it while streaming the body.
    serverActions: { bodySizeLimit: "26mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
