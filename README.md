# Warthog

Your agents work for you, on your terms, from your home.

A personal agent home: one place a person owns that every AI agent connects through — holding who
they are, what each agent may touch and spend, and a record of everything agents do.

- Requirements: [`brief.yaml`](brief.yaml)
- Design of record: [`docs/design/technical-design.md`](docs/design/technical-design.md)

```bash
npm install
cp .env.example .env.local
npm run dev        # http://localhost:3000
npm test           # unit tests (node:test via tsx)
npm run typecheck
```

Built by Skynet's build loop, task by task, test-first.
