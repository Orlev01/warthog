# Warthog

[![Release checks](https://github.com/Orlev01/warthog/actions/workflows/ci.yml/badge.svg)](https://github.com/Orlev01/warthog/actions/workflows/ci.yml)

Your agents work for you, on your terms, from your home.

A personal agent home: one place a person owns that every AI agent connects through — holding who
they are, what each agent may touch and spend, and a record of everything agents do.

- Requirements: [`brief.yaml`](brief.yaml)
- Design of record: [`docs/design/technical-design.md`](docs/design/technical-design.md)
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
installed. The [acceptance-fixes release](docs/audit/acceptance-fixes-release-2026-11-10.md)
is running with SMS disabled, one healthy replica and verified private database
access. Delivery workflows are enabled for manual, reviewed use; future deployments
still require approval. The release record and [current state](state.md) track
verified domain activation and remaining live acceptance checks.

Application: [app.warthog.com.au](https://app.warthog.com.au).

Built by Skynet's build loop, task by task, test-first.
