# Warthog

[![Release checks](https://github.com/Orlev01/warthog/actions/workflows/ci.yml/badge.svg)](https://github.com/Orlev01/warthog/actions/workflows/ci.yml)

Your agents work for you, on your terms, from your home.

A personal agent home: one place a person owns that every AI agent connects through — holding who
they are, what each agent may touch and spend, and a record of everything agents do.

- Requirements: [`brief.yaml`](brief.yaml)
- Design of record: [`docs/design/technical-design.md`](docs/design/technical-design.md)
- Comprehensive code, security and UX review: [11 November bug bash](docs/audit/bug-bash-2026-11-11/coordinator.md)
- Current release audit and open launch gates: [`docs/audit/README.md`](docs/audit/README.md)
- Azure CI/CD and approved release procedure: [`docs/azure-delivery.md`](docs/azure-delivery.md)

```bash
npm install
cp .env.example .env.local
npm run dev        # http://localhost:3000
npm test           # unit tests (node:test via tsx)
npm run typecheck
```

Use Node 22. The committed environment file contains public development fixtures;
production requires separately approved credentials and infrastructure. For the
clean Docker/PostgreSQL checks, see [`docs/local-release-validation.md`](docs/local-release-validation.md).
The approved Azure foundation, scoped permissions and production credentials are
installed. The [bug-bash release](docs/audit/bug-bash-release-2026-11-11.md)
is running with SMS disabled, one healthy replica and verified private database
access. Delivery workflows are enabled for manual, reviewed use; future deployments
still require approval. The release record and [current state](state.md) track
verified domain activation and remaining live acceptance checks.

Application: [app.warthog.com.au](https://app.warthog.com.au).

Built by Skynet's build loop, task by task, test-first.

## Agent management

Start with **Agents**, then open an agent's workspace to manage its connectors,
vault access, skills, memory, spending, rules, audit log and settings. Top-level
resource screens manage account-owned inventory. **Settings → Global agent
settings** configures defaults for new connections; global rules apply to all
agents, including existing ones.

See [the ownership and access model](docs/adr/agent-first-management.md) and
[the cross-domain review](docs/audit/agent-first-review-2026-11-10.md) for enforced
behaviour, validation and remaining integration limits.

## Admin portal

The founder's operational view lives on a second host served by the same container,
`admin.warthog.com.au`: sign-ups and activation, usage, reliability, traffic and system
health, read only from plaintext operational metadata and the personal-content-free metric
store (never vault contents, never a list of addresses). It is entered from **Settings →
Admin portal** by an account with the `admin` role (the configured `OPERATOR_EMAIL`,
promoted hourly) after a fresh passkey or authenticator confirmation; the admin host never
signs anyone in itself. See the [decision](docs/adr/admin-portal.md), the
[design](docs/design/admin-portal.md) and the [launch runbook](docs/admin-portal-launch.md)
(binding the hostname is a separate approved step). Locally the portal is
`http://admin.localhost:3000` with `OPERATOR_EMAIL` set to your own sign-up address.

## OAuth connection compatibility

The 11 November security update binds refresh tokens to their issuing OAuth
client. Older OAuth agent connections need reauthorization when their existing
access token expires. Reauthorization creates a new connection: review/reapply
custom permissions, then remove the obsolete entry after the replacement works.
Static access keys and provider connector credentials are unaffected. See the
[migration decision](docs/adr/oauth-refresh-client-binding.md).
