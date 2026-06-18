# Initial Prompt for Claude Code

Use this prompt to bootstrap the ledger project in Claude Code. Copy-paste it as your first message.

---

## Prompt

I'm building a general-purpose financial ledger service. All architecture decisions are documented in the `architecture/` folder and project conventions are in `CLAUDE.md`. Read both thoroughly before doing anything.

Start by scaffolding the project:

1. **Monorepo setup** — initialise an npm workspace monorepo with these packages: `api`, `settlement-worker`, `outbox-relay`, `audit-consumer`, `shared`. TypeScript strict mode for all.

2. **Shared package first:**
   - Knex config and DB client (Postgres)
   - Database migrations for all entities defined in `architecture/02-data-model.md` (organisations, users, wallets, transactions, journal_entries, journal_lines, outbox)
   - Shared TypeScript types/enums for transaction status, outbox event types, journal line direction
   - Amounts are bigint (smallest currency unit). UUIDs for all PKs.

3. **docker-compose.yml** for local dev — Postgres 16 and Kafka (with Zookeeper or KRaft) with health checks.

4. **API service skeleton** — Express with TypeScript, health check endpoint, error handling middleware, request ID middleware. Don't implement the business endpoints yet — just the scaffolding.

After scaffolding, stop and let me review before building the business logic. I want to verify the migration schema matches the architecture docs before we build on top of it.
