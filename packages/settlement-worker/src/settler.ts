import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { TransactionStatus, JournalLineDirection, getMeter, getTracer } from '@ledger/shared';
import { SpanStatusCode } from '@opentelemetry/api';

export interface SettlementPayload {
  transaction_id: string;
  source_wallet_id: string;
  destination_wallet_id: string;
  amount: number;
  currency: string;
}

const meter = getMeter('settlement-worker');
const tracer = getTracer('settlement-worker');

const settledCounter = meter.createCounter('settlement_transactions_total', {
  description: 'Transactions processed by the settlement worker',
});
const batchDurationHisto = meter.createHistogram('settlement_batch_duration_ms', {
  description: 'Time to settle one destination-wallet group (ms)',
  unit: 'ms',
});

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
  return tracer.startActiveSpan('settlement.settle_group', async (span) => {
    span.setAttribute('settlement.destination_wallet_id', destinationWalletId);
    span.setAttribute('settlement.group_size', items.length);

    const start = Date.now();
    try {
      await db.transaction(async (trx) => {
        let totalCredited = 0;
        let settledCount = 0;
        let skippedCount = 0;

        for (const item of items) {
          // Idempotency guard (DD-6): only proceed if transaction is still PENDING.
          // If another worker already settled it, or the user cancelled it, skip.
          const [settled] = await trx('transactions')
            .where({ id: item.transaction_id, status: TransactionStatus.PENDING })
            .update({ status: TransactionStatus.SETTLED, settled_at: new Date() })
            .returning('id');

          if (!settled) {
            console.log(`[settlement-worker] ${item.transaction_id} already handled — skipping`);
            skippedCount++;
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
          settledCount++;
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

        settledCounter.add(settledCount, { result: 'settled' });
        if (skippedCount > 0) settledCounter.add(skippedCount, { result: 'skipped' });
        span.setAttribute('settlement.settled', settledCount);
        span.setAttribute('settlement.skipped', skippedCount);
      });

      batchDurationHisto.record(Date.now() - start);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } catch (err) {
      batchDurationHisto.record(Date.now() - start);
      settledCounter.add(items.length, { result: 'error' });
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.end();
      throw err;
    }
  });
}
