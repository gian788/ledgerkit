# Testing Strategy

## DD-18: Testing Strategy

**Unit tests:**

- Cover complex business logic only — balance checks, reservation logic, batch aggregation, idempotency handling.
- Not needed for simple CRUD or pass-through routes.

**Integration tests:**

- Service boundary level — each workload tested against real dependencies (Postgres, Kafka via testcontainers or similar).
- API service: HTTP request → DB state verification.
- Settlement worker: Kafka message → journal entries + balance updates verified in DB.
- Outbox relay: DB outbox row → Kafka message published.
- Audit consumer: Kafka message → S3 write verified.

**End-to-end tests:**

- Small number covering the main use cases:
  - Create ledger → create accounts → submit transaction → verify settlement → check balances and journal entries
  - Submit transaction → cancel before settlement → verify funds released
  - Submit transaction with insufficient funds → verify rejection

**Stress tests — k6:**

k6 scripts output to Prometheus, so Grafana dashboards work during load tests for real-time observation.

| Scenario             | What it tests                                                                                           | Setup                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Hot wallet**       | Row-level contention, settlement batching, single Kafka partition throughput                            | 2 wallets transferring back and forth at max rate                            |
| **Distributed load** | Overall system throughput, API capacity, DB connection pool, Kafka partition spread, worker parallelism | Thousands of wallets, low activity each, traffic spread evenly               |
| **Fan-out (payout)** | Source-side reservation contention under fan-out, batching when bottleneck is on sender not receiver    | 1 sender wallet paying out to many receiver wallets (payroll/payout pattern) |

**Stress test success criteria (TBD at implementation):**

- Target throughput (transactions/s) sustained for N minutes
- p99 latency stays below threshold under load
- Settlement lag (Kafka consumer lag) stays bounded
- Zero balance inconsistencies (sum of all debits = sum of all credits across the ledger)
- No transaction stuck in PENDING beyond settlement SLA
