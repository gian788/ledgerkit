import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../middleware/requestId';
import { errorHandler, AppError } from '../middleware/errorHandler';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(handler: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.get('/test', handler);
  app.use(errorHandler);
  return app;
}

// ── requestIdMiddleware ───────────────────────────────────────────────────────

describe('requestIdMiddleware', () => {
  it('generates a UUID request ID when no X-Request-Id header is sent', async () => {
    const app = makeApp((_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');

    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('echoes back the X-Request-Id header provided by the client', async () => {
    const app = makeApp((_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test').set('X-Request-Id', 'my-idempotency-id-123');

    expect(res.headers['x-request-id']).toBe('my-idempotency-id-123');
  });

  it('makes requestId available on res.locals', async () => {
    let capturedId: string | undefined;
    const app = makeApp((_req, res) => {
      capturedId = res.locals['requestId'] as string;
      res.json({ ok: true });
    });

    await request(app).get('/test');

    expect(typeof capturedId).toBe('string');
    expect(capturedId!.length).toBeGreaterThan(0);
  });

  it('keeps res.locals.requestId in sync with the response header', async () => {
    let capturedId: string | undefined;
    const app = makeApp((_req, res) => {
      capturedId = res.locals['requestId'] as string;
      res.json({ ok: true });
    });

    const res = await request(app).get('/test');

    expect(capturedId).toBe(res.headers['x-request-id']);
  });

  it('generates a unique ID for each request', async () => {
    const app = makeApp((_req, res) => res.json({ ok: true }));

    const [res1, res2] = await Promise.all([request(app).get('/test'), request(app).get('/test')]);

    expect(res1.headers['x-request-id']).not.toBe(res2.headers['x-request-id']);
  });
});

// ── errorHandler ──────────────────────────────────────────────────────────────

describe('errorHandler', () => {
  it('returns the correct status code and error shape for an AppError', async () => {
    const app = makeApp((_req, _res, next) => {
      next(new AppError(422, 'INSUFFICIENT_FUNDS', 'Not enough funds'));
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({ code: 'INSUFFICIENT_FUNDS', message: 'Not enough funds' });
    expect(typeof res.body.request_id).toBe('string');
  });

  it('includes the request_id from the middleware in AppError responses', async () => {
    const app = makeApp((_req, _res, next) => {
      next(new AppError(400, 'VALIDATION_ERROR', 'Bad input'));
    });

    const res = await request(app).get('/test').set('X-Request-Id', 'trace-abc-123');

    expect(res.body.request_id).toBe('trace-abc-123');
  });

  it('returns 500 with INTERNAL_ERROR code for unexpected errors in development', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';

    const app = makeApp((_req, _res, next) => {
      next(new Error('Unexpected boom'));
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toContain('Unexpected boom');
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    process.env['NODE_ENV'] = prev;
    consoleSpy.mockRestore();
  });

  it('hides error details in production', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';

    const app = makeApp((_req, _res, next) => {
      next(new Error('Secret internal detail'));
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body.error.message).not.toContain('Secret internal detail');
    expect(res.body.error.message).toBe('An unexpected error occurred.');
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    process.env['NODE_ENV'] = prev;
    consoleSpy.mockRestore();
  });

  it('returns 400 for a validation AppError', async () => {
    const app = makeApp((_req, _res, next) => {
      next(
        new AppError(400, 'VALIDATION_ERROR', 'name is required and must be a non-empty string'),
      );
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a not-found AppError', async () => {
    const app = makeApp((_req, _res, next) => {
      next(new AppError(404, 'NOT_FOUND', 'Organisation not found'));
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
