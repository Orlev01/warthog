# Framework and compiler upgrade

Status: implementation under validation, 12 November 2026.

The five initial dependency PRs are reviewed as one compatible set. Next 15.5.29
explicitly rejects TypeScript 7 because it needs the JavaScript compiler API.
Next 16.4.5 supports the native TypeScript compiler, so these upgrades travel
together. No compiler or build errors are ignored.

TypeScript 7 removes `baseUrl`; the existing `@/*` alias now resolves directly to
`./src/*`. Next requires the automatic JSX runtime and includes development route
types. The Node middleware becomes the Node proxy with the same nonce CSP,
authentication rate limits and upload cap. `skipProxyUrlNormalize` preserves the
exact OAuth redirect URI; the real HTTP loopback-callback regression remains a
release check.

Keep Webpack explicitly for both development and production. The initial
Turbopack probe warned that dynamic migration loading traced the whole project.
Changing bundlers is unnecessary for these dependency updates and would enlarge
the runtime-packaging review. Standalone packaging and artifact checks still run.

Tailwind and its PostCSS integration move together to 4.3.5, and Dependabot groups
their future updates. SimpleWebAuthn server 14.1.0 adds validation and attestation
fixes without changing the application's passkey policy. Node declarations stay
on major 22, matching the deployed Node 22 image; PR #6's Node 26 declarations are
not suitable for that runtime. Dependabot continues checking Node 22 updates.

Primary references:

- [Next 16 migration guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [TypeScript 7 release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [SimpleWebAuthn 14.1.0](https://github.com/MasterKale/SimpleWebAuthn/releases/tag/v14.1.0)
- [Tailwind 4.3.5](https://github.com/tailwindlabs/tailwindcss/releases/tag/v4.3.5)
