import request from 'supertest';
import type { Knex } from 'knex';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createApp } from '../app';
import { startTestDb, stopTestDb, cleanDb } from './helpers';

describe('Accounts (Wallets)', () => {
  let app: ReturnType<typeof createApp>;
  let db: Knex;
  let container: StartedPostgreSqlContainer;
  let orgId: string;

  beforeAll(async () => {
    ({ db, container } = await startTestDb());
    app = createApp(db);
  }, 90_000);

  afterAll(async () => {
    await stopTestDb({ db, container });
  });

  beforeEach(async () => {
    await cleanDb(db);
    // Create a default org for most tests
    const res = await request(app).post('/organisations').send({
      name: 'Test Org',
      jurisdiction: 'GB',
      residency: 'GB',
    });
    orgId = (res.body as { id: string }).id;
  });

  // ── POST /organisations/:org_id/accounts ───────────────────────────────────

  it('creates a wallet and returns 201', async () => {
    const res = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'GBP' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      organisation_id: orgId,
      currency: 'GBP',
      balance: '0',
      pending_amount: '0',
    });
    expect(typeof res.body.id).toBe('string');
  });

  it('creates wallets in multiple currencies for the same org', async () => {
    await request(app).post(`/organisations/${orgId}/accounts`).send({ currency: 'GBP' });
    await request(app).post(`/organisations/${orgId}/accounts`).send({ currency: 'EUR' });
    await request(app).post(`/organisations/${orgId}/accounts`).send({ currency: 'USD' });

    const res = await request(app).get(`/organisations/${orgId}/accounts`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    const currencies = res.body.map((w: { currency: string }) => w.currency).sort();
    expect(currencies).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('returns 400 for invalid currency code', async () => {
    const res = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'gbp' }); // lowercase
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-3-letter currency', async () => {
    const res = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'GB' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when org does not exist', async () => {
    const res = await request(app)
      .post('/organisations/00000000-0000-0000-0000-000000000000/accounts')
      .send({ currency: 'GBP' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── GET /accounts/:id ─────────────────────────────────────────────────────

  it('returns a wallet by id', async () => {
    const create = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'GBP' });
    const { id } = create.body as { id: string };

    const res = await request(app).get(`/accounts/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.currency).toBe('GBP');
  });

  it('returns 404 for unknown account id', async () => {
    const res = await request(app).get('/accounts/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── GET /accounts/:id/balance ─────────────────────────────────────────────

  it('returns balance shape with available = balance - pending_amount', async () => {
    const create = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'GBP' });
    const { id } = create.body as { id: string };

    const res = await request(app).get(`/accounts/${id}/balance`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      account_id: id,
      currency: 'GBP',
      balance: '0',
      pending_amount: '0',
      available: '0',
    });
    expect(res.body.updated_at).toBeDefined();
  });

  it('returns 404 for unknown account on balance endpoint', async () => {
    const res = await request(app).get('/accounts/00000000-0000-0000-0000-000000000000/balance');
    expect(res.status).toBe(404);
  });

  // ── GET /organisations/:org_id/accounts ───────────────────────────────────

  it('lists accounts for an org', async () => {
    await request(app).post(`/organisations/${orgId}/accounts`).send({ currency: 'GBP' });
    await request(app).post(`/organisations/${orgId}/accounts`).send({ currency: 'EUR' });

    const res = await request(app).get(`/organisations/${orgId}/accounts`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('filters accounts by currency', async () => {
    await request(app).post(`/organisations/${orgId}/accounts`).send({ currency: 'GBP' });
    await request(app).post(`/organisations/${orgId}/accounts`).send({ currency: 'EUR' });

    const res = await request(app).get(`/organisations/${orgId}/accounts?currency=GBP`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].currency).toBe('GBP');
  });

  it('does not return accounts from another org', async () => {
    const other = await request(app).post('/organisations').send({
      name: 'Other Org',
      jurisdiction: 'US',
      residency: 'US',
    });
    const otherId = (other.body as { id: string }).id;
    await request(app).post(`/organisations/${otherId}/accounts`).send({ currency: 'USD' });

    const res = await request(app).get(`/organisations/${orgId}/accounts`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('returns 404 listing accounts for unknown org', async () => {
    const res = await request(app).get('/organisations/00000000-0000-0000-0000-000000000000/accounts');
    expect(res.status).toBe(404);
  });
});
