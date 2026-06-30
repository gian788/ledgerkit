/**
 * Debug/test-only routes. Mounted only when NODE_ENV !== 'production'.
 * Never expose these in production — they bypass business rules.
 */
import { Router } from 'express';
import type { Knex } from 'knex';
import { AppError } from '../middleware/errorHandler';
import { requirePositiveInteger, requireUUID } from '../utils/validation';

export function makeDebugRoutes(db: Knex): Router {
  const router = Router();

  // Directly credit a wallet's balance — for seeding load tests.
  // POST /debug/accounts/:id/fund  { amount: <positive integer pence> }
  router.post('/accounts/:id/fund', async (req, res, next) => {
    try {
      const id = requireUUID(req.params as Record<string, unknown>, 'id');
      const amount = requirePositiveInteger(req.body as Record<string, unknown>, 'amount');

      const [wallet] = await db('wallets')
        .where({ id })
        .update({ balance: db.raw('balance + ?', [amount]), updated_at: db.fn.now() })
        .returning('*');

      if (!wallet) {
        throw new AppError(404, 'NOT_FOUND', 'Wallet not found');
      }

      res.json(wallet);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
