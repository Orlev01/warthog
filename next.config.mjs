/**
 * Next.js configuration. Routes live under `src/app`.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Sent on every response. Scripts/styles are not restricted here (Next's inline bootstrap needs
// nonces for that); framing, plugins, <base> hijacking and cross-site form posts are forbidden.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
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
    "@electric-sql/pglite",
    "@azure/identity",
    "@azure/keyvault-keys",
    "@azure/storage-blob",
    "@azure/communication-email",
    "@azure/communication-sms",
  ],
  outputFileTracingExcludes: { "*": ["node_modules/@electric-sql/pglite/**"] },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
