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
Azure delivery workflows are manual and disabled until their setup and approval
gates are satisfied. A passing build is not production launch approval.

Built by Skynet's build loop, task by task, test-first.
