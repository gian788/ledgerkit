# CLAUDE.md — Ledger Service

## Project overview

General-purpose financial ledger with REST API. Double-entry bookkeeping, async settlement via Kafka, regulatory-grade audit log.

Read all files in `architecture/` before making any design or implementation decisions. They are the source of truth for every architectural choice.

## Tech stack

- **Runtime:** Node.js with TypeScript
- **Framework:** Express (API service)
- **Database:** PostgreSQL (managed — Aurora/RDS/Cloud SQL)
- **Queue:** Apache Kafka
- **ORM/Query:** Knex.js for migrations and query building (no heavy ORM — we want explicit SQL control for financial operations)
- **Testing:** Jest (unit + integration), testcontainers (Postgres + Kafka for integration tests), k6 (stress tests)
- **Containerisation:** Docker
- **Orchestration:** Kubernetes with Helm charts
- **Observability:** OpenTelemetry SDK, Prometheus, Grafana, Jaeger

## Repository structure

```
ledger/
├── CLAUDE.md
├── architecture/           # Architecture decision records (read-only reference)
│   ├── 01-overview.md
│   ├── 02-data-model.md
│   ├── 03-settlement.md
│   ├── 04-api-surface.md
│   ├── 05-audit-log.md
│   ├── 06-infrastructure.md
│   ├── 07-cicd.md
│   └── 08-testing.md
├── packages/               # Monorepo workspaces
│   ├── api/                # API service (Express)
│   ├── settlement-worker/  # Kafka consumer, batch settlement
│   ├── outbox-relay/       # Polls outbox table, publishes to Kafka
│   ├── audit-consumer/     # Kafka consumer, writes to S3
│   └── shared/             # Shared types, DB client, OTel setup, Kafka config
├── migrations/             # Knex database migrations (shared across services)
├── helm/                   # Helm charts per workload
│   ├── api/
│   ├── settlement-worker/
│   ├── outbox-relay/
│   └── audit-consumer/
├── k6/                     # Stress test scripts
├── docker-compose.yml      # Local dev (Postgres + Kafka + Zookeeper)
└── Dockerfile              # Multi-stage build (shared base)
```

## Code conventions

- **TypeScript strict mode** — `strict: true` in tsconfig, no `any` types.
- **Amounts are always bigint** — stored and transmitted as integers in the smallest currency unit (pence, cents). Never use floating point for money.
- **UUIDs for all primary keys** — generated server-side with `crypto.randomUUID()`.
- **Idempotency keys** — required on all write endpoints. Stored in the transactions table. Duplicate key returns the original response, not an error.
- **Error handling** — structured error responses with consistent shape. Never leak stack traces in production.
- **SQL over ORM magic** — use Knex query builder for complex queries (especially the atomic conditional update). Avoid abstracting away the SQL for financial operations — explicitness matters.
- **One DB transaction per critical path** — the accept flow (reservation + transaction insert + outbox insert) must be a single Postgres transaction. Never split it.

## Key invariants (never break these)

1. **Double-entry balance:** for every journal entry, sum of debits must equal sum of credits.
2. **Atomic reservation:** balance check and `pending_amount` update happen in one SQL statement, never two.
3. **Conditional state transitions:** transaction status changes use `UPDATE ... WHERE status = 'PENDING'` — never update without checking current state.
4. **Outbox atomicity:** outbox rows are inserted in the same DB transaction as the state change they represent.
5. **Settlement idempotency:** the settlement worker must be safe to replay — never settle an already-settled transaction.

## Local development

```bash
# Start dependencies
docker-compose up -d

# Run migrations
npm run migrate --workspace=packages/shared

# Start API
npm run dev --workspace=packages/api

# Start settlement worker
npm run dev --workspace=packages/settlement-worker

# Start outbox relay
npm run dev --workspace=packages/outbox-relay
```

## Testing

```bash
# Unit tests
npm test --workspace=packages/api

# Integration tests (requires testcontainers / Docker)
npm run test:integration --workspace=packages/api

# Stress tests
k6 run k6/hot-wallet.js
```

## Implementation order

Build in this sequence — each phase is independently testable:

1. **Shared package** — DB client, migrations, types, config
2. **API service** — CRUD endpoints for ledgers, accounts; transaction creation with reservation; cancel endpoint
3. **Outbox relay** — poll outbox, publish to Kafka
4. **Settlement worker** — consume from Kafka, batch settle, write journal entries
5. **Audit consumer** — consume audit events, write to S3
6. **Observability** — OTel instrumentation across all services
7. **Helm charts** — K8s manifests for all workloads
8. **Stress tests** — k6 scripts for the three scenarios
