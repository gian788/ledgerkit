import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';
import type { Knex } from 'knex';
import type { Organisation } from '@ledger/shared';
import { AppError } from '../middleware/errorHandler';
import { requireString } from '../utils/validation';

export function makeOrganisationsController(db: Knex) {
  const create: RequestHandler = async (req, res, next) => {
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
  };

  const list: RequestHandler = async (req, res, next) => {
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
  };

  const getById: RequestHandler = async (req, res, next) => {
    try {
      const org = await db<Organisation>('organisations')
        .where({ id: req.params['org_id'] })
        .first();

      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organisation not found');
      res.json(org);
    } catch (err) {
      next(err);
    }
  };

  return { create, list, getById };
}
