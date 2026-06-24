import request from 'supertest';
import type { Knex } from 'knex';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createApp } from '../../app';
import { startTestDb, stopTestDb, cleanDb, seedBalance, countOutboxRows } from './helpers';

describe('E2E: ledger scenarios', () => {
  let app: ReturnType<typeof createApp>;
  let db: Knex;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    ({ db, container } = await startTestDb());
    app = createApp(db);
  }, 90_000);

  afterAll(async () => {
    await stopTestDb({ db, container });
  });

  beforeEach(async () => {
    await cleanDb(db);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function createOrg() {
    const res = await request(app)
      .post('/organisations')
      .send({ name: 'Acme', jurisdiction: 'GB', residency: 'GB' });
    return (res.body as { id: string }).id;
  }

  async function createWallet(orgId: string, currency = 'GBP') {
    const res = await request(app).post(`/organisations/${orgId}/accounts`).send({ currency });
    return (res.body as { id: string }).id;
  }

  // ── Scenario 1: Reserve then cancel ──────────────────────────────────────
  //
  // Verifies that balance invariants hold at every step and that the outbox
  // trail accumulates correctly (2 rows after create, 3 after cancel).

  it('reserves funds on create and releases them fully on cancel', async () => {
    const orgId = await createOrg();
    const srcId = await createWallet(orgId);
    const dstId = await createWallet(orgId);
    await seedBalance(db, srcId, 10_000);

    // Create transaction
    const createRes = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'e2e-s1',
      source_wallet_id: srcId,
      destination_wallet_id: dstId,
      amount: 4000,
      currency: 'GBP',
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('PENDING');
    const txId = (createRes.body as { id: string }).id;

    // Balance after reservation
    const balAfterCreate = await request(app).get(`/accounts/${srcId}/balance`);
    expect(balAfterCreate.body).toMatchObject({
      balance: '10000',
      pending_amount: '4000',
      available: '6000',
    });

    // Outbox immediately after create: 1 SETTLEMENT + 1 AUDIT
    expect(await countOutboxRows(db, txId)).toBe(2);
    expect(await countOutboxRows(db, txId, 'SETTLEMENT')).toBe(1);
    expect(await countOutboxRows(db, txId, 'AUDIT')).toBe(1);

    // Cancel
    const cancelRes = await request(app).post(`/transactions/${txId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    // Balance fully restored
    const balAfterCancel = await request(app).get(`/accounts/${srcId}/balance`);
    expect(balAfterCancel.body).toMatchObject({
      balance: '10000',
      pending_amount: '0',
      available: '10000',
    });

    // Cancel appended a second AUDIT row; SETTLEMENT row count unchanged
    expect(await countOutboxRows(db, txId, 'AUDIT')).toBe(2);
    expect(await countOutboxRows(db, txId, 'SETTLEMENT')).toBe(1);

    // Verify the cancel audit row has the correct event
    const cancelAuditRows = await db('outbox')
      .where({ transaction_id: txId, type: 'AUDIT' })
      .orderBy('created_at', 'desc')
      .limit(1);
    const payload = cancelAuditRows[0].payload as { event: string };
    expect(payload.event).toBe('TRANSACTION_CANCELLED');
  });

  // ── Scenario 2: Insufficient funds — complete rollback ────────────────────
  //
  // A rejected transaction must leave no rows in transactions or outbox — the
  // DB transaction rolled back atomically. The balance endpoint alone can't
  // confirm this; direct DB counts can.

  it('leaves zero DB rows when a transaction is rejected for insufficient funds', async () => {
    const orgId = await createOrg();
    const srcId = await createWallet(orgId);
    const dstId = await createWallet(orgId);
    await seedBalance(db, srcId, 500);

    const res = await request(app).post(`/organisations/${orgId}/transactions`).send({
      idempotency_key: 'e2e-s2',
      source_wallet_id: srcId,
      destination_wallet_id: dstId,
      amount: 501,
      currency: 'GBP',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // API confirms balance untouched
    const bal = await request(app).get(`/accounts/${srcId}/balance`);
    expect(bal.body).toMatchObject({ pending_amount: '0', available: '500' });

    // DB confirms the write was rolled back entirely
    const [{ count: txCount }] = await db('transactions').count<[{ count: string }]>('id as count');
    expect(Number(txCount)).toBe(0);

    const [{ count: outboxCount }] = await db('outbox').count<[{ count: string }]>('id as count');
    expect(Number(outboxCount)).toBe(0);
  });

  // ── Scenario 3: Idempotency — reservation applied exactly once ────────────
  //
  // Two requests with the same idempotency key must produce exactly one
  // reservation, one transaction row, and two outbox rows — not double.

  it('applies the reservation exactly once when the same idempotency key is replayed', async () => {
    const orgId = await createOrg();
    const srcId = await createWallet(orgId);
    const dstId = await createWallet(orgId);
    await seedBalance(db, srcId, 10_000);

    const body = {
      idempotency_key: 'e2e-s3-idem',
      source_wallet_id: srcId,
      destination_wallet_id: dstId,
      amount: 3000,
      currency: 'GBP',
    };

    const first = await request(app).post(`/organisations/${orgId}/transactions`).send(body);
    expect(first.status).toBe(201);
    const txId = (first.body as { id: string }).id;

    const second = await request(app).post(`/organisations/${orgId}/transactions`).send(body);
    expect(second.status).toBe(200);
    expect((second.body as { id: string }).id).toBe(txId);

    // Balance: reserved exactly once
    const bal = await request(app).get(`/accounts/${srcId}/balance`);
    expect(bal.body).toMatchObject({ pending_amount: '3000', available: '7000' });

    // DB: exactly one transaction row and two outbox rows
    const [{ count: txCount }] = await db('transactions').count<[{ count: string }]>('id as count');
    expect(Number(txCount)).toBe(1);

    expect(await countOutboxRows(db, txId)).toBe(2);

    // List: single entry
    const list = await request(app).get(`/organisations/${orgId}/transactions`);
    expect(list.body).toHaveLength(1);
  });
});
