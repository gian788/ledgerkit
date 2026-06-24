import { getDb, closeDb, config } from '@ledger/shared';
import { Kafka, Partitioners, logLevel } from 'kafkajs';
import { pollOnce } from './relay';

const POLL_INTERVAL_MS = 500;

let isRunning = true;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
