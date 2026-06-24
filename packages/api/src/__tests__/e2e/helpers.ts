import type { Knex } from 'knex';

export { startTestDb, stopTestDb, cleanDb } from '../integration/helpers';

export async function seedBalance(db: Knex, walletId: string, amount: number): Promise<void> {
  await db('wallets').where({ id: walletId }).update({ balance: amount });
}

export async function countOutboxRows(
  db: Knex,
  transactionId: string,
  type?: 'SETTLEMENT' | 'AUDIT',
): Promise<number> {
  const query = db('outbox').where({ transaction_id: transactionId });
  if (type) query.where({ type });
  const [{ count }] = await query.count<[{ count: string }]>('id as count');
  return Number(count);
}
