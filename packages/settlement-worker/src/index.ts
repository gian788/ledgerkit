import { getDb, closeDb, config } from '@ledger/shared';
import { Kafka, logLevel } from 'kafkajs';
import { settleBatch, type SettlementPayload } from './settler';

async function main(): Promise<void> {
  const db = getDb();

  const kafka = new Kafka({
    clientId: `${config.kafka.clientId}-settlement-worker`,
    brokers: config.kafka.brokers,
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 100, retries: 8 },
  });

  const consumer = kafka.consumer({ groupId: 'settlement-worker' });
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topics.transactions, fromBeginning: false });
  console.log('[settlement-worker] connected, consuming transactions.pending...');

  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[settlement-worker] shutting down...');
    await consumer.disconnect();
    await closeDb();
    console.log('[settlement-worker] shutdown complete');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await consumer.run({
    // eachBatch gives us a full Kafka fetch batch per invocation. Messages in
    // a batch come from one partition (keyed by destination_wallet_id), so
    // settleBatch naturally groups same-destination transactions together (DD-8).
    eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
      const items: SettlementPayload[] = [];

      for (const message of batch.messages) {
        if (!message.value) continue;
        try {
          const payload = JSON.parse(message.value.toString()) as SettlementPayload;
          items.push(payload);
        } catch (err) {
          console.error('[settlement-worker] failed to parse message:', err);
        }
      }

      // Throws on DB failure → offsets are not committed → Kafka re-delivers
      await settleBatch(db, items);

      for (const message of batch.messages) {
        resolveOffset(message.offset);
      }
      await heartbeat();
    },
  });
}

main().catch((err) => {
  console.error('[settlement-worker] fatal:', err);
  process.exit(1);
});
