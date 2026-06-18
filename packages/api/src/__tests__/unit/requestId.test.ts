import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../middleware/requestId';
import { errorHandler } from '../../middleware/errorHandler';

function makeApp(handler: RequestHandler) {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/test', handler);
  app.use(errorHandler);
  return app;
}

describe('requestIdMiddleware', () => {
  it('generates a UUID when no X-Request-Id header is sent', async () => {
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
