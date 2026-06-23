import { Router } from 'express';
import type { Knex } from 'knex';
import { makeTransactionsController } from '../controllers/transactions';

export function makeTransactionRoutes(db: Knex): Router {
  const router = Router();
  const txns = makeTransactionsController(db);

  router.get('/:id', txns.getById);
  router.post('/:id/cancel', txns.cancel);

  return router;
}
