import type { Knex } from 'knex';
import type { Producer } from 'kafkajs';
import { OutboxEventType, config } from '@ledger/shared';
import type { OutboxRow } from '@ledger/shared';

export const BATCH_SIZE = 100;

export function getTopicForRow(type: OutboxRow['type']): string {
  return type === OutboxEventType.SETTLEMENT
    ? config.kafka.topics.transactions
    : config.kafka.topics.audit;
}

export function getKeyForRow(row: Pick<OutboxRow, 'type' | 'payload' | 'transaction_id'>): string {
  return row.type === OutboxEventType.SETTLEMENT
    ? String((row.payload as { destination_wallet_id: string }).destination_wallet_id)
    : row.transaction_id;
}

export async function pollOnce(db: Knex, producer: Producer): Promise<void> {
  const rows = await db<OutboxRow>('outbox')
    .where({ published: false })
    .orderBy('created_at', 'asc')
    .limit(BATCH_SIZE);

  if (rows.length === 0) return;

  for (const row of rows) {
    await producer.send({
      topic: getTopicForRow(row.type),
      messages: [{ key: getKeyForRow(row), value: JSON.stringify(row.payload) }],
    });

    // Mark published immediately after send — safe to re-run on relay restart;
    // consumers must be idempotent.
    await db('outbox').where({ id: row.id }).update({ published: true, published_at: new Date() });
  }
}
