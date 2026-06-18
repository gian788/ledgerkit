# Settlement Architecture

## DD-7: Outbox pattern for settlement triggering

Decoupled architecture: API nodes → queue → settlement workers, each scaling independently.

**The dual-write problem:** API node needs to write to DB (transaction + reservation) and publish to a queue. These can't be done atomically across two systems. If the DB write succeeds but the queue publish fails, funds are reserved with no settlement trigger.

**Solution — outbox pattern:**

1. **API node** — single DB transaction: atomic `pending_amount` update, insert PENDING transaction, insert outbox row. Returns to caller.
2. **Outbox relay** — reads unpublished outbox rows, publishes to queue, marks as published.
3. **Queue** — buffers individual transaction events.
4. **Settlement worker** — consumes from queue, batches by destination wallet, settles the batch in one DB transaction.

**Why outbox over publish-after-commit + sweeper:**
- No crash window — outbox row is committed atomically with the transaction, so no event is ever silently lost.
- Better observability — outbox table is inspectable (unpublished count, oldest row age, relay lag).
- Tradeoff accepted: extra DB writes (outbox row per transaction), extra component (relay process), and outbox table maintenance (cleanup of published rows).

**Relay mechanism:** Polling the outbox table on a short interval (100–500ms). Simpler to operate than CDC/Debezium. Can revisit if polling load becomes a concern at scale.

## DD-8: Batched settlement for hot wallets

Settlement worker batches transactions by destination wallet to reduce write contention.

Strategy: collect messages for up to N messages or T milliseconds (whichever comes first), group by destination wallet, settle each wallet's batch in one DB transaction.

Per batch, the settlement worker:
1. Insert journal entries + lines for all transactions in the batch
2. Decrement sender `pending_amount` and `balance` per transaction (may touch multiple sender wallets)
3. Increment receiver `balance` once with the aggregated sum
4. Mark all transactions as SETTLED

This reduces receiver-side contention from N individual updates to 1 per batch window. Sender-side contention is unavoidable (each sender is different) but brief.

**Idempotency requirement:** both the outbox relay and the settlement worker must be idempotent — the relay can re-publish, and the worker can receive duplicates. Settlement must check transaction status before processing.

## DD-10: Queue technology — Kafka

Kafka chosen for:
- **Partition-based ordering** — partition by destination wallet ID, so all transactions for the same wallet land on the same consumer. Natural fit for batching.
- **Consumer groups** — settlement workers scale horizontally, each owning a subset of partitions.
- **Replay capability** — if a settlement worker needs to reprocess, the offset can be rewound.
- **Mainstream ecosystem** — broad tooling, well-understood operationally.

Topic design: single `transactions.pending` topic, partitioned by destination wallet ID.
