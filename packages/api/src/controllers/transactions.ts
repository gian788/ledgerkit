import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';
import type { Knex } from 'knex';
import { TransactionStatus, OutboxEventType } from '@ledger/shared';
import type { Transaction, Wallet } from '@ledger/shared';
import { AppError } from '../middleware/errorHandler';
import { requireString, requirePositiveInteger, requireUUID } from '../utils/validation';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  );
}

export function makeTransactionsController(db: Knex) {
  const create: RequestHandler = async (req, res, next) => {
    try {
      const { org_id } = req.params as { org_id: string };
      const body = req.body as Record<string, unknown>;

      const idempotency_key = requireString(body, 'idempotency_key');
      const source_wallet_id = requireUUID(body, 'source_wallet_id');
      const destination_wallet_id = requireUUID(body, 'destination_wallet_id');
      const amount = requirePositiveInteger(body, 'amount');
      const currency = requireString(body, 'currency');

      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'currency must be a 3-letter ISO 4217 code (e.g. GBP)',
        );
      }

      if (source_wallet_id === destination_wallet_id) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'source_wallet_id and destination_wallet_id must be different',
        );
      }

      let tx: Transaction;
      let isReplay = false;

      try {
        const result = await db.transaction(async (trx) => {
          // 1. Idempotency — return original if key already used
          const existing = await trx<Transaction>('transactions')
            .where({ idempotency_key })
            .first();
          if (existing) return { tx: existing, replay: true };

          // 2. Validate source wallet exists and belongs to the org
          const sourceWallet = await trx<Wallet>('wallets')
            .where({ id: source_wallet_id, organisation_id: org_id })
            .first();
          if (!sourceWallet) {
            throw new AppError(404, 'NOT_FOUND', 'Source wallet not found in this organisation');
          }

          // 3. Validate destination wallet exists (can belong to any org)
          const destWallet = await trx<Wallet>('wallets')
            .where({ id: destination_wallet_id })
            .first();
          if (!destWallet) {
            throw new AppError(404, 'NOT_FOUND', 'Destination wallet not found');
          }

          // 4. Currency must match both wallets
          if (sourceWallet.currency !== currency) {
            throw new AppError(
              422,
              'CURRENCY_MISMATCH',
              `Source wallet currency is ${sourceWallet.currency}, not ${currency}`,
            );
          }
          if (destWallet.currency !== currency) {
            throw new AppError(
              422,
              'CURRENCY_MISMATCH',
              `Destination wallet currency is ${destWallet.currency}, not ${currency}`,
            );
          }

          // 5. Atomic reservation (DD-5): single conditional UPDATE
          //    Zero rows → insufficient available balance (balance - pending_amount < amount)
          const reserved = await trx('wallets')
            .where({ id: source_wallet_id })
            .whereRaw('balance - pending_amount >= ?', [amount])
            .update({
              pending_amount: trx.raw('pending_amount + ?', [amount]),
              updated_at: trx.fn.now(),
            });

          if (reserved === 0) {
            throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient available balance');
          }

          // 6. Insert PENDING transaction
          const txId = randomUUID();
          const [newTx] = await trx<Transaction>('transactions')
            .insert({
              id: txId,
              idempotency_key,
              source_wallet_id,
              destination_wallet_id,
              amount: BigInt(amount),
              currency,
              status: TransactionStatus.PENDING,
            })
            .returning('*');

          // 7. Insert outbox rows in the same DB transaction (DD-7)
          await trx('outbox').insert([
            {
              id: randomUUID(),
              type: OutboxEventType.SETTLEMENT,
              transaction_id: txId,
              payload: JSON.stringify({
                transaction_id: txId,
                source_wallet_id,
                destination_wallet_id,
                amount,
                currency,
              }),
            },
            {
              id: randomUUID(),
              type: OutboxEventType.AUDIT,
              transaction_id: txId,
              payload: JSON.stringify({
                event: 'TRANSACTION_CREATED',
                resource_type: 'transaction',
                resource_id: txId,
                after: {
                  id: txId,
                  idempotency_key,
                  source_wallet_id,
                  destination_wallet_id,
                  amount,
                  currency,
                  status: TransactionStatus.PENDING,
                },
              }),
            },
          ]);

          return { tx: newTx, replay: false };
        });

        tx = result.tx;
        isReplay = result.replay;
      } catch (err) {
        // Two concurrent requests with the same idempotency key: the second one
        // loses the race on the UNIQUE constraint. Fetch and replay the winner.
        if (isUniqueViolation(err)) {
          const existing = await db<Transaction>('transactions').where({ idempotency_key }).first();
          if (existing) return res.status(200).json(existing);
        }
        throw err;
      }

      res.status(isReplay ? 200 : 201).json(tx);
    } catch (err) {
      next(err);
    }
  };

  const getById: RequestHandler = async (req, res, next) => {
    try {
      const tx = await db<Transaction>('transactions').where({ id: req.params['id'] }).first();
      if (!tx) throw new AppError(404, 'NOT_FOUND', 'Transaction not found');
      res.json(tx);
    } catch (err) {
      next(err);
    }
  };

  const cancel: RequestHandler = async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      const cancelled = await db.transaction(async (trx) => {
        // Conditional UPDATE — only matches if status is PENDING (DD-6)
        const [result] = await trx<Transaction>('transactions')
          .where({ id, status: TransactionStatus.PENDING })
          .update({ status: TransactionStatus.CANCELLED })
          .returning('*');

        if (!result) {
          const existing = await trx<Transaction>('transactions').where({ id }).first();
          if (!existing) throw new AppError(404, 'NOT_FOUND', 'Transaction not found');
          throw new AppError(
            409,
            'CONFLICT',
            `Transaction cannot be cancelled — current status is ${existing.status}`,
          );
        }

        // Release the reserved funds on the source wallet
        await trx('wallets')
          .where({ id: result.source_wallet_id })
          .update({
            pending_amount: trx.raw('pending_amount - ?', [Number(result.amount)]),
            updated_at: trx.fn.now(),
          });

        // Audit trail (DD-7)
        await trx('outbox').insert({
          id: randomUUID(),
          type: OutboxEventType.AUDIT,
          transaction_id: id,
          payload: JSON.stringify({
            event: 'TRANSACTION_CANCELLED',
            resource_type: 'transaction',
            resource_id: id,
            before: { status: TransactionStatus.PENDING },
            after: { status: TransactionStatus.CANCELLED },
          }),
        });

        return result;
      });

      res.json(cancelled);
    } catch (err) {
      next(err);
    }
  };

  const list: RequestHandler = async (req, res, next) => {
    try {
      const { org_id } = req.params as { org_id: string };

      const walletIds = await db('wallets')
        .where({ organisation_id: org_id })
        .pluck<string[]>('id');

      let query = db<Transaction>('transactions')
        .where((q) =>
          q.whereIn('source_wallet_id', walletIds).orWhereIn('destination_wallet_id', walletIds),
        )
        .orderBy('created_at', 'desc');

      const { status, source_wallet_id, destination_wallet_id, from, to } = req.query as Record<
        string,
        string | undefined
      >;

      if (status) query = query.where({ status });
      if (source_wallet_id) query = query.where({ source_wallet_id });
      if (destination_wallet_id) query = query.where({ destination_wallet_id });
      if (from) query = query.where('created_at', '>=', from);
      if (to) query = query.where('created_at', '<=', to);

      const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
      const offset = Number(req.query['offset'] ?? 0);

      res.json(await query.limit(limit).offset(offset));
    } catch (err) {
      next(err);
    }
  };

  return { create, getById, cancel, list };
}
