import request from 'supertest';
import type { Knex } from 'knex';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createApp } from '../../app';
import { startTestDb, stopTestDb, cleanDb } from './helpers';

describe('Transactions', () => {
  let app: ReturnType<typeof createApp>;
  let db: Knex;
  let container: StartedPostgreSqlContainer;

  let orgId: string;
  let sourceWalletId: string;
  let destWalletId: string;

  beforeAll(async () => {
    ({ db, container } = await startTestDb());
    app = createApp(db);
  }, 90_000);

  afterAll(async () => {
    await stopTestDb({ db, container });
  });

  beforeEach(async () => {
    await cleanDb(db);

    // Create org
    const orgRes = await request(app)
      .post('/organisations')
      .send({ name: 'Acme', jurisdiction: 'GB', residency: 'GB' });
    orgId = (orgRes.body as { id: string }).id;

    // Source wallet — will be funded below
    const srcRes = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'GBP' });
    sourceWalletId = (srcRes.body as { id: string }).id;

    // Destination wallet (same org, same currency)
    const dstRes = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'GBP' });
    destWalletId = (dstRes.body as { id: string }).id;

    // Fund the source wallet directly — balance changes come from the settlement
    // worker in production, so we bypass the API here in tests.
    await db('wallets').where({ id: sourceWalletId }).update({ balance: 10_000 });
  });

  // ── POST /organisations/:org_id/transactions ──────────────────────────────

  it('creates a PENDING transaction and reserves the amount in pending_amount', async () => {
    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-1',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 3000,
      currency: 'GBP',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: '3000',
      currency: 'GBP',
      status: 'PENDING',
    });
    expect(typeof res.body.id).toBe('string');

    // pending_amount should now be 3000, available 7000
    const balRes = await request(app).get(`/accounts/${sourceWalletId}/balance`);
    expect(balRes.body).toMatchObject({
      balance: '10000',
      pending_amount: '3000',
      available: '7000',
    });
  });

  it('inserts SETTLEMENT and AUDIT outbox rows inside the same DB transaction', async () => {
    await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-outbox',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 1000,
      currency: 'GBP',
    });

    const rows = await db('outbox').orderBy('created_at', 'asc');
    expect(rows).toHaveLength(2);

    const types = rows.map((r: { type: string }) => r.type).sort();
    expect(types).toEqual(['AUDIT', 'SETTLEMENT']);
  });

  it('replays an idempotency key and returns 200 with the original transaction', async () => {
    const body = {
      idempotency_key: 'idem-replay',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 500,
      currency: 'GBP',
    };

    const first = await request(app).post(`/organisations/${orgId}/transactions`).send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post(`/organisations/${orgId}/transactions`).send(body);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe((first.body as { id: string }).id);

    // pending_amount should only be reserved once
    const balRes = await request(app).get(`/accounts/${sourceWalletId}/balance`);
    expect(balRes.body.pending_amount).toBe('500');
  });

  it('returns 422 INSUFFICIENT_FUNDS when available balance is too low', async () => {
    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-insuf',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 99_999,
      currency: 'GBP',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // Balance must be untouched
    const balRes = await request(app).get(`/accounts/${sourceWalletId}/balance`);
    expect(balRes.body.pending_amount).toBe('0');
  });

  it('returns 422 when source wallet currency does not match requested currency', async () => {
    // Create a EUR wallet and try to send GBP through it
    const eurRes = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'EUR' });
    const eurWalletId = (eurRes.body as { id: string }).id;

    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-mismatch',
      source_wallet_id: eurWalletId,
      destination_wallet_id: destWalletId,
      amount: 500,
      currency: 'GBP',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('returns 404 when source wallet does not exist in the org', async () => {
    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-nosrc',
      source_wallet_id: '00000000-0000-0000-0000-000000000000',
      destination_wallet_id: destWalletId,
      amount: 500,
      currency: 'GBP',
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when destination wallet does not exist', async () => {
    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-nodst',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: '00000000-0000-0000-0000-000000000000',
      amount: 500,
      currency: 'GBP',
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when source and destination are the same wallet', async () => {
    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-self',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: sourceWalletId,
      amount: 500,
      currency: 'GBP',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a non-positive amount', async () => {
    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-badamt',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: -100,
      currency: 'GBP',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a missing idempotency_key', async () => {
    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 500,
      currency: 'GBP',
    });

    expect(res.status).toBe(400);
  });

  // ── GET /transactions/:id ─────────────────────────────────────────────────

  it('returns the transaction by ID', async () => {
    const createRes = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-get',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 200,
      currency: 'GBP',
    });

    const txId = (createRes.body as { id: string }).id;
    const res = await request(app).get(`/transactions/${txId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(txId);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.amount).toBe('200');
  });

  it('returns 404 for an unknown transaction ID', async () => {
    const res = await request(app).get('/transactions/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── POST /transactions/:id/cancel ─────────────────────────────────────────

  it('cancels a PENDING transaction and releases pending_amount', async () => {
    const createRes = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-cancel',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 4000,
      currency: 'GBP',
    });

    const txId = (createRes.body as { id: string }).id;

    // pending_amount reserved
    const beforeBal = await request(app).get(`/accounts/${sourceWalletId}/balance`);
    expect(beforeBal.body.pending_amount).toBe('4000');

    const cancelRes = await request(app).post(`/transactions/${txId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    // pending_amount released
    const afterBal = await request(app).get(`/accounts/${sourceWalletId}/balance`);
    expect(afterBal.body.pending_amount).toBe('0');
  });

  it('returns 409 when cancelling an already-cancelled transaction', async () => {
    const createRes = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'idem-dbl-cancel',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 100,
      currency: 'GBP',
    });

    const txId = (createRes.body as { id: string }).id;

    await request(app).post(`/transactions/${txId}/cancel`);
    const res = await request(app).post(`/transactions/${txId}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 when cancelling an unknown transaction', async () => {
    const res = await request(app).post(
      '/transactions/00000000-0000-0000-0000-000000000000/cancel',
    );
    expect(res.status).toBe(404);
  });

  // ── GET /organisations/:org_id/transactions ───────────────────────────────

  it('lists all transactions involving the org wallets', async () => {
    await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'list-1',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 100,
      currency: 'GBP',
    });

    await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'list-2',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 200,
      currency: 'GBP',
    });

    const res = await request(app).get(`/organisations/${orgId}/transactions`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('filters transactions by status', async () => {
    const createRes = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'filter-1',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 100,
      currency: 'GBP',
    });

    const txId = (createRes.body as { id: string }).id;

    await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'filter-2',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 200,
      currency: 'GBP',
    });

    await request(app).post(`/transactions/${txId}/cancel`);

    const pending = await request(app).get(`/organisations/${orgId}/transactions?status=PENDING`);
    expect(pending.body).toHaveLength(1);

    const cancelled = await request(app).get(
      `/organisations/${orgId}/transactions?status=CANCELLED`,
    );
    expect(cancelled.body).toHaveLength(1);
  });

  it('filters transactions by source_wallet_id', async () => {
    // Second source wallet in the same org
    const src2Res = await request(app)
      .post(`/organisations/${orgId}/accounts`)
      .send({ currency: 'GBP' });
    const src2Id = (src2Res.body as { id: string }).id;
    await db('wallets').where({ id: src2Id }).update({ balance: 5_000 });

    await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'sw-1',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWalletId,
      amount: 100,
      currency: 'GBP',
    });
    await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'sw-2',
      source_wallet_id: src2Id,
      destination_wallet_id: destWalletId,
      amount: 100,
      currency: 'GBP',
    });

    const res = await request(app).get(
      `/organisations/${orgId}/transactions?source_wallet_id=${sourceWalletId}`,
    );
    expect(res.body).toHaveLength(1);
    expect(res.body[0].source_wallet_id).toBe(sourceWalletId);
  });
});
