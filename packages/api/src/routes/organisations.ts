import { Router } from 'express';
import type { Knex } from 'knex';
import { makeOrganisationsController } from '../controllers/organisations';
import { makeAccountsController } from '../controllers/accounts';
import { makeTransactionsController } from '../controllers/transactions';

export function makeOrganisationRoutes(db: Knex): Router {
  const router = Router();
  const orgs = makeOrganisationsController(db);
  const accounts = makeAccountsController(db);
  const txns = makeTransactionsController(db);

  router.post('/', orgs.create);
  router.get('/', orgs.list);
  router.get('/:org_id', orgs.getById);
  router.post('/:org_id/accounts', accounts.create);
  router.get('/:org_id/accounts', accounts.list);
  router.post('/:org_id/transactions', txns.create);
  router.get('/:org_id/transactions', txns.list);

  return router;
}
