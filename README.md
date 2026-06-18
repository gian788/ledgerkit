# Ledger Service

General-purpose financial ledger with a REST API. Implements double-entry bookkeeping with async settlement via Kafka and a regulatory-grade audit log.

## Architecture

```
┌─────────────┐     ┌──────────┐     ┌─────────┐     ┌─────────┐
│  API Nodes  │────▶│ Postgres │────▶│  Relay  │────▶│  Kafka  │
│ (stateless) │     │          │     │         │     │         │
└─────────────┘     └──────────┘     └─────────┘     └────┬────┘
                         ▲                                  │
                         │              ┌───────────────────┤
                         │              │                   │
                         │              ▼                   ▼
                         │   ┌───────────────────┐  ┌──────────────┐
                         └───│ Settlement Workers│  │Audit Consumer│
                             │   (batch + write) │  │   (→ S3)     │
                             └───────────────────┘  └──────────────┘
```

**Services:**

| Service | Description |
|---|---|
| `packages/api` | Stateless Express API — accepts transactions, manages ledgers and accounts |
| `packages/settlement-worker` | Kafka consumer — batches by destination wallet, settles and writes journal entries |
| `packages/outbox-relay` | Polls the outbox table, publishes events to Kafka (single active instance via leader election) |
| `packages/audit-consumer` | Kafka consumer — writes audit events to S3 Object Lock |
| `packages/shared` | DB client, migrations, types, OpenTelemetry setup, Kafka config |

**Managed dependencies (outside K8s):** Postgres (RDS/Aurora/Cloud SQL) and Kafka (MSK/Confluent Cloud).

## Transaction lifecycle

Transactions follow a two-phase flow:

1. **Accept (synchronous):** validate balance, atomically reserve funds via a single `UPDATE ... WHERE balance - pending_amount >= amount`, insert a `PENDING` transaction and an outbox row — all in one DB transaction. Return to caller immediately.
2. **Settle (async):** outbox relay publishes the event to Kafka; settlement workers consume, batch by destination wallet, write journal entries (debit + credit lines), update balances, and mark transactions `SETTLED`.

Cancellation is best-effort: `UPDATE ... WHERE status = 'PENDING'` — whichever side (cancel or settlement worker) wins the conditional update, the other becomes a no-op.

## Key design invariants

- **Amounts are `bigint`** — stored as integers in the smallest currency unit (pence, cents). No floating point.
- **Double-entry balance** — every journal entry has balanced debit and credit lines.
- **Atomic reservation** — balance check and `pending_amount` update are a single SQL statement, never two separate operations.
- **Outbox atomicity** — outbox rows are inserted in the same DB transaction as the state change they represent, eliminating dual-write risk.
- **Settlement idempotency** — the worker checks `status = 'PENDING'` before settling; safe to replay on duplicate Kafka messages.
- **Idempotency keys** — required on all write endpoints; duplicate keys return the original response.

## Tech stack

- **Runtime:** Node.js + TypeScript (strict mode)
- **Framework:** Express
- **Database:** PostgreSQL via Knex.js (explicit SQL — no heavy ORM)
- **Queue:** Apache Kafka
- **Testing:** Jest, testcontainers, k6
- **Observability:** OpenTelemetry SDK, Prometheus, Grafana, Jaeger
- **Containerisation:** Docker
- **Orchestration:** Kubernetes with Helm charts

## Local development

```bash
# Start Postgres + Kafka + Zookeeper
docker-compose up -d

# Run migrations
npm run migrate --workspace=packages/shared

# Start services (each in a separate terminal)
npm run dev --workspace=packages/api
npm run dev --workspace=packages/settlement-worker
npm run dev --workspace=packages/outbox-relay
```

## API

Base paths:

```
POST   /ledgers
GET    /ledgers/:ledger_id
GET    /ledgers

POST   /ledgers/:ledger_id/accounts
GET    /accounts/:id
GET    /accounts/:id/balance
GET    /ledgers/:ledger_id/accounts

POST   /ledgers/:ledger_id/transactions
GET    /transactions/:tx_id
POST   /transactions/:tx_id/cancel
GET    /ledgers/:ledger_id/transactions

GET    /journal-entries/:id
GET    /ledgers/:ledger_id/journal-entries
```

All amounts are in the smallest currency unit (e.g. pence for GBP). Balance response:

```json
{
  "account_id": "uuid",
  "currency": "GBP",
  "balance": 1000000,
  "pending_amount": 50000,
  "available": 950000,
  "updated_at": "2025-01-15T10:30:00Z"
}
```

## Testing

```bash
# Unit tests
npm test --workspace=packages/api

# Integration tests (requires Docker for testcontainers)
npm run test:integration --workspace=packages/api

# Stress tests
k6 run k6/hot-wallet.js
```

**Stress test scenarios:** hot wallet (row-level contention), distributed load (overall throughput), and fan-out/payout (source reservation contention).

## Repository layout

```
ledger/
├── architecture/           # Architecture decision records — read before making design decisions
├── packages/
│   ├── api/
│   ├── settlement-worker/
│   ├── outbox-relay/
│   ├── audit-consumer/
│   └── shared/
├── migrations/             # Knex migrations (shared across services)
├── helm/                   # Helm charts per workload
├── k6/                     # Stress test scripts
├── docker-compose.yml
└── Dockerfile
```

See [`architecture/`](architecture/) for detailed design decisions covering the data model, settlement strategy, API surface, audit log, infrastructure, CI/CD, and testing.
