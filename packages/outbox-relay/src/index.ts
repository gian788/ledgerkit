import { getDb, closeDb, config, OutboxEventType } from '@ledger/shared';
import type { OutboxRow } from '@ledger/shared';
import { Kafka, Partitioners, type Producer, logLevel } from 'kafkajs';

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 500;

let isRunning = true;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOnce(db: ReturnType<typeof getDb>, producer: Producer): Promise<void> {
  const rows = await db<OutboxRow>('outbox')
    .where({ published: false })
    .orderBy('created_at', 'asc')
    .limit(BATCH_SIZE);

  if (rows.length === 0) return;

  for (const row of rows) {
    const topic =
      row.type === OutboxEventType.SETTLEMENT
        ? config.kafka.topics.transactions
        : config.kafka.topics.audit;

    // Partition by destination wallet for SETTLEMENT (DD-10: same-wallet
    // transactions land on the same partition for ordered, batched settlement)
    const key =
      row.type === OutboxEventType.SETTLEMENT
        ? String((row.payload as { destination_wallet_id: string }).destination_wallet_id)
        : row.transaction_id;

    await producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(row.payload) }],
    });

    // Mark published immediately after send — if relay crashes before this
    // update, the row will be re-sent on restart. Consumers must be idempotent.
    await db('outbox').where({ id: row.id }).update({ published: true, published_at: new Date() });

    console.log(`[outbox-relay] ${row.type} ${row.id} → ${topic}`);
  }
}

async function main(): Promise<void> {
  const db = getDb();

  const kafka = new Kafka({
    clientId: `${config.kafka.clientId}-outbox-relay`,
    brokers: config.kafka.brokers,
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 100, retries: 8 },
  });

  const producer = kafka.producer({
    // LegacyPartitioner maps key → partition deterministically, ensuring all
    // transactions for the same destination wallet land on the same partition
    // (required for DD-10 ordered batched settlement).
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  await producer.connect();
  console.log('[outbox-relay] connected to Kafka, polling outbox...');

  process.on('SIGTERM', () => {
    isRunning = false;
  });
  process.on('SIGINT', () => {
    isRunning = false;
  });

  while (isRunning) {
    try {
      await pollOnce(db, producer);
    } catch (err) {
      console.error('[outbox-relay] poll error:', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await producer.disconnect();
  await closeDb();
  console.log('[outbox-relay] shutdown complete');
}

main().catch((err) => {
  console.error('[outbox-relay] fatal:', err);
  process.exit(1);
});
