import { Router } from 'express';
import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import type { Organisation } from '@ledger/shared';
import { AppError } from '../middleware/errorHandler.js';

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

export function makeOrganisationRoutes(db: Knex): Router {
  const router = Router();

  // POST /organisations
  router.post('/', async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = requireString(body, 'name');
      const jurisdiction = requireString(body, 'jurisdiction');
      const residency = requireString(body, 'residency');

      const [org] = await db<Organisation>('organisations')
        .insert({ id: randomUUID(), name, jurisdiction, residency })
        .returning('*');

      res.status(201).json(org);
    } catch (err) {
      next(err);
    }
  });

  // GET /organisations
  router.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query['limit'] ?? 50), 200);
      const offset = Number(req.query['offset'] ?? 0);

      const orgs = await db<Organisation>('organisations')
        .orderBy('created_at', 'asc')
        .limit(limit)
        .offset(offset);

      res.json(orgs);
    } catch (err) {
      next(err);
    }
  });

  // GET /organisations/:org_id
  router.get('/:org_id', async (req, res, next) => {
    try {
      const org = await db<Organisation>('organisations')
        .where({ id: req.params['org_id'] })
        .first();

      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organisation not found');
      res.json(org);
    } catch (err) {
      next(err);
    }
  });

  // POST /organisations/:org_id/accounts — create wallet under this org
  // (mounted here so the org_id param is in scope)
  router.post('/:org_id/accounts', async (req, res, next) => {
    try {
      const { org_id } = req.params as { org_id: string };
      const body = req.body as Record<string, unknown>;

      const org = await db<Organisation>('organisations').where({ id: org_id }).first();
      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organisation not found');

      const currency = requireString(body, 'currency');
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'currency must be a 3-letter ISO 4217 code (e.g. GBP)');
      }

      const [wallet] = await db('wallets')
        .insert({ id: randomUUID(), organisation_id: org_id, currency, balance: 0, pending_amount: 0 })
        .returning('*');

      res.status(201).json(wallet);
    } catch (err) {
      next(err);
    }
  });

  // GET /organisations/:org_id/accounts — list wallets (filter: ?currency=GBP)
  router.get('/:org_id/accounts', async (req, res, next) => {
    try {
      const { org_id } = req.params as { org_id: string };

      const org = await db<Organisation>('organisations').where({ id: org_id }).first();
      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organisation not found');

      let query = db('wallets')
        .where({ organisation_id: org_id })
        .orderBy('created_at', 'asc');

      const currency = req.query['currency'];
      if (typeof currency === 'string' && currency !== '') {
        query = query.where({ currency: currency.toUpperCase() });
      }

      const wallets = await query;
      res.json(wallets);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
