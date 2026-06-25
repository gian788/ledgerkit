import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { TransactionStatus, JournalLineDirection } from '@ledger/shared';

export interface SettlementPayload {
  transaction_id: string;
  source_wallet_id: string;
  destination_wallet_id: string;
  amount: number;
  currency: string;
}

/**
 * Settle a batch of transactions, grouping by destination wallet so the
 * receiver row is updated once per group (DD-8 contention reduction).
 * Each group runs in a single DB transaction.
 */
export async function settleBatch(db: Knex, items: SettlementPayload[]): Promise<void> {
  if (items.length === 0) return;

  const groups = new Map<string, SettlementPayload[]>();
  for (const item of items) {
    const group = groups.get(item.destination_wallet_id) ?? [];
    group.push(item);
    groups.set(item.destination_wallet_id, group);
  }

  for (const [destinationWalletId, group] of groups) {
    await settleGroup(db, destinationWalletId, group);
  }
}

async function settleGroup(
  db: Knex,
  destinationWalletId: string,
  items: SettlementPayload[],
): Promise<void> {
  await db.transaction(async (trx) => {
    let totalCredited = 0;

    for (const item of items) {
      // Idempotency guard (DD-6): only proceed if transaction is still PENDING.
      // If another worker already settled it, or the user cancelled it, skip.
      const [settled] = await trx('transactions')
        .where({ id: item.transaction_id, status: TransactionStatus.PENDING })
        .update({ status: TransactionStatus.SETTLED, settled_at: new Date() })
        .returning('id');

      if (!settled) {
        console.log(`[settlement-worker] ${item.transaction_id} already handled — skipping`);
        continue;
      }

      // Double-entry journal (DD-2): debit sender, credit receiver
      const entryId = randomUUID();
      await trx('journal_entries').insert({
        id: entryId,
        transaction_id: item.transaction_id,
        description: `${item.amount} ${item.currency}`,
      });

      await trx('journal_lines').insert([
        {
          id: randomUUID(),
          journal_entry_id: entryId,
          wallet_id: item.source_wallet_id,
          amount: item.amount,
          direction: JournalLineDirection.DEBIT,
        },
        {
          id: randomUUID(),
          journal_entry_id: entryId,
          wallet_id: item.destination_wallet_id,
          amount: item.amount,
          direction: JournalLineDirection.CREDIT,
        },
      ]);

      // Source wallet: release reservation and deduct balance (DD-4)
      await trx('wallets')
        .where({ id: item.source_wallet_id })
        .update({
          balance: trx.raw('balance - ?', [item.amount]),
          pending_amount: trx.raw('pending_amount - ?', [item.amount]),
          updated_at: trx.fn.now(),
        });

      totalCredited += item.amount;
    }

    if (totalCredited > 0) {
      // Single receiver update for the entire group (DD-8)
      await trx('wallets')
        .where({ id: destinationWalletId })
        .update({
          balance: trx.raw('balance + ?', [totalCredited]),
          updated_at: trx.fn.now(),
        });
    }
  });
}
