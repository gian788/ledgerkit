import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';
import type { Knex } from 'knex';
import type { Organisation, Wallet } from '@ledger/shared';
import { AppError } from '../middleware/errorHandler';
import { requireString } from '../utils/validation';

export function makeAccountsController(db: Knex): {
  create: RequestHandler;
  list: RequestHandler;
  getById: RequestHandler;
  getBalance: RequestHandler;
} {
  const create: RequestHandler = async (req, res, next) => {
    try {
      const { org_id } = req.params as { org_id: string };
      const body = req.body as Record<string, unknown>;

      const org = await db<Organisation>('organisations').where({ id: org_id }).first();
      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organisation not found');

      const currency = requireString(body, 'currency');
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'currency must be a 3-letter ISO 4217 code (e.g. GBP)',
        );
      }

      const [wallet] = await db('wallets')
        .insert({
          id: randomUUID(),
          organisation_id: org_id,
          currency,
          balance: 0,
          pending_amount: 0,
        })
        .returning('*');

      res.status(201).json(wallet);
    } catch (err) {
      next(err);
    }
  };

  const list: RequestHandler = async (req, res, next) => {
    try {
      const { org_id } = req.params as { org_id: string };

      const org = await db<Organisation>('organisations').where({ id: org_id }).first();
      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organisation not found');

      let query = db('wallets').where({ organisation_id: org_id }).orderBy('created_at', 'asc');

      const currency = req.query['currency'];
      if (typeof currency === 'string' && currency !== '') {
        query = query.where({ currency: currency.toUpperCase() });
      }

      res.json(await query);
    } catch (err) {
      next(err);
    }
  };

  const getById: RequestHandler = async (req, res, next) => {
    try {
      const wallet = await db<Wallet>('wallets').where({ id: req.params['id'] }).first();
      if (!wallet) throw new AppError(404, 'NOT_FOUND', 'Account not found');
      res.json(wallet);
    } catch (err) {
      next(err);
    }
  };

  const getBalance: RequestHandler = async (req, res, next) => {
    try {
      const wallet = await db<Wallet>('wallets').where({ id: req.params['id'] }).first();
      if (!wallet) throw new AppError(404, 'NOT_FOUND', 'Account not found');

      res.json({
        account_id: wallet.id,
        currency: wallet.currency,
        balance: wallet.balance,
        pending_amount: wallet.pending_amount,
        available: wallet.balance - wallet.pending_amount,
        updated_at: wallet.updated_at,
      });
    } catch (err) {
      next(err);
    }
  };

  return { create, list, getById, getBalance };
}
