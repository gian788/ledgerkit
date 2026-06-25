import { config } from '@ledger/shared';
import { Kafka, logLevel } from 'kafkajs';
import { S3AuditStorage, makeS3Client } from './storage';
import { processAuditMessage } from './consumer';

async function main(): Promise<void> {
  const s3 = makeS3Client(config.s3);
  const storage = new S3AuditStorage(s3, config.s3.auditBucket);
  await storage.ensureBucket();
  console.log(`[audit-consumer] bucket ready: ${config.s3.auditBucket}`);

  const kafka = new Kafka({
    clientId: `${config.kafka.clientId}-audit-consumer`,
    brokers: config.kafka.brokers,
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 100, retries: 8 },
  });

  const consumer = kafka.consumer({ groupId: 'audit-consumer' });
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topics.audit, fromBeginning: false });
  console.log('[audit-consumer] connected, consuming audit.events...');

  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[audit-consumer] shutting down...');
    await consumer.disconnect();
    console.log('[audit-consumer] shutdown complete');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;

      try {
        await processAuditMessage(message.value.toString(), storage);
      } catch (err) {
        // Log and continue — a poison-pill message must not stall the consumer.
        // In production, route to a DLQ here.
        console.error('[audit-consumer] failed to process message:', err);
      }
    },
  });
}

main().catch((err) => {
  console.error('[audit-consumer] fatal:', err);
  process.exit(1);
});
