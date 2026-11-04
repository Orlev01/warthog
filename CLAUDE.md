# Warthog — agent orientation

Warthog is a Skynet job: a personal "agent home" — a Next.js + Postgres web app that is itself a remote
MCP server (agents connect to it) and an OAuth 2.1 authorization server, hosted on Azure.

Read before you change anything:
- `brief.yaml` — the ratified requirements (the WHAT). Ground truth; never contradict it.
- `docs/design/technical-design.md` — the design of record (the HOW): data protection, auth, MCP,
  connector engine, policy engine, activity hash chain, notifications, libraries.
- `.agent/conventions.md` and `.agent/constitution.md` — the rules every build agent follows.

Hard rules (details in the design doc):
- Test-first. `npm test` (node:test via tsx) and `npm run typecheck` must stay green.
- Runtime dependencies are limited to `package.json` as pinned; adding one needs a job ADR.
- Never log, store or return card numbers, security codes, high-tier values, codes, tokens or keys in
  plain text — run everything through the redaction module before it reaches activity/logs/metrics.
- Every member-scoped query is filtered by the session's user id, never an id from the client.
- Warthog never calls an AI model.
- Do not modify anything under `.agent/` unless your role says so.
