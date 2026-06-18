import { Router } from 'express';
import type { Knex } from 'knex';
import type { Wallet } from '@ledger/shared';
import { AppError } from '../middleware/errorHandler.js';

export function makeAccountRoutes(db: Knex): Router {
  const router = Router();

  // GET /accounts/:id
  router.get('/:id', async (req, res, next) => {
    try {
      const wallet = await db<Wallet>('wallets')
        .where({ id: req.params['id'] })
        .first();

      if (!wallet) throw new AppError(404, 'NOT_FOUND', 'Account not found');
      res.json(wallet);
    } catch (err) {
      next(err);
    }
  });

  // GET /accounts/:id/balance
  router.get('/:id/balance', async (req, res, next) => {
    try {
      const wallet = await db<Wallet>('wallets')
        .where({ id: req.params['id'] })
        .first();

      if (!wallet) throw new AppError(404, 'NOT_FOUND', 'Account not found');

      const available = wallet.balance - wallet.pending_amount;

      res.json({
        account_id: wallet.id,
        currency: wallet.currency,
        balance: wallet.balance,
        pending_amount: wallet.pending_amount,
        available,
        updated_at: wallet.updated_at,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
