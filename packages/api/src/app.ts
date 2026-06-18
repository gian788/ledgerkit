import express from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp(): express.Application {
  const app = express();

  // Serialize BigInt as string — amounts from the DB are BigInt, JSON.stringify
  // throws on BigInt by default.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

  app.use(express.json());
  app.use(requestIdMiddleware);

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Business routes (not yet implemented) ────────────────────────────────
  // POST   /ledgers
  // GET    /ledgers/:ledger_id
  // GET    /ledgers
  // POST   /ledgers/:ledger_id/accounts
  // GET    /accounts/:id
  // GET    /accounts/:id/balance
  // GET    /ledgers/:ledger_id/accounts
  // POST   /ledgers/:ledger_id/transactions
  // GET    /transactions/:tx_id
  // POST   /transactions/:tx_id/cancel
  // GET    /ledgers/:ledger_id/transactions
  // GET    /journal-entries/:id
  // GET    /ledgers/:ledger_id/journal-entries

  // ── 404 catch-all (must be after all routes) ─────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  app.use(errorHandler);

  return app;
}
