import express from 'express';
import type { Knex } from 'knex';
import { requestIdMiddleware } from './middleware/requestId';
import { errorHandler } from './middleware/errorHandler';
import { makeOrganisationRoutes } from './routes/organisations';
import { makeAccountRoutes } from './routes/accounts';
import { makeTransactionRoutes } from './routes/transactions';
import { makeDebugRoutes } from './routes/debug';

export function createApp(
  db: Knex,
  nodeEnv = process.env['NODE_ENV'] ?? 'development',
): express.Application {
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

  // ── Business routes ───────────────────────────────────────────────────────
  app.use('/organisations', makeOrganisationRoutes(db));
  app.use('/accounts', makeAccountRoutes(db));
  app.use('/transactions', makeTransactionRoutes(db));

  // ── Debug/test-only routes (non-production only) ──────────────────────────
  if (nodeEnv !== 'production') {
    app.use('/debug', makeDebugRoutes(db));
  }

  // ── 404 catch-all ─────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  app.use(errorHandler);

  return app;
}
