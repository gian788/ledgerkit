# Audit Log

## DD-13: Audit log — immutable, async, WORM storage

**Purpose:** Regulatory-grade audit trail for FCA/EU compliance. Must be tamper-proof, append-only, and retained for 5–7 years.

**What is logged:**

- Every API mutation (transaction created, cancelled)
- Every settlement worker state change (transaction settled, failed)
- Failed authentication/authorisation attempts
- Balance reads are NOT logged separately (captured in API request logs)

**Event payload:** Before and after state of the primary resource only (e.g. transaction status change). Does not capture every row touched (e.g. balance deltas on wallets) — keeps payload small, especially for batched settlement.

**Async via outbox + Kafka:**

- Audit events written to the outbox table in the same DB transaction as the state change — no crash window, no lost events.
- Outbox relay publishes to a dedicated `audit.events` Kafka topic (separate from `transactions.pending`).
- Audit consumer reads from the topic and persists to WORM storage.

**Storage: S3 Object Lock (compliance mode)**

- No delete, no overwrite, including by root. Satisfies FCA record-keeping requirements.
- Adapter pattern: define an interface (writeEvent, queryByTimeRange, queryByEntityId), implement for S3 first. GCS and Azure Blob adapters can be added later.

**GDPR considerations:**

- No direct PII in audit events. Wallet IDs and organisation IDs are pseudonymised data — traceable to individuals via the identity service.
- Retention is legally defensible under Article 17(3)(b) — right to erasure does not apply when retention is required for legal/regulatory compliance (AML, FCA).
- Lawful basis, access controls, and storage limitation must be documented.

## DD-14: Outbox table carries multiple event types

The outbox table serves both settlement triggering and audit logging:

- **outbox.type** field distinguishes event types: `SETTLEMENT` vs `AUDIT`
- Relay publishes to the appropriate Kafka topic based on type:
  - `SETTLEMENT` → `transactions.pending` topic (partitioned by destination wallet ID)
  - `AUDIT` → `audit.events` topic
- Same relay process, same polling mechanism, different routing.
