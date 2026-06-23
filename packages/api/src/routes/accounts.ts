import { Router } from 'express';
import type { Knex } from 'knex';
import { makeAccountsController } from '../controllers/accounts';

export function makeAccountRoutes(db: Knex): Router {
  const router = Router();
  const accounts = makeAccountsController(db);

  router.get('/:id', accounts.getById);
  router.get('/:id/balance', accounts.getBalance);

  return router;
}
