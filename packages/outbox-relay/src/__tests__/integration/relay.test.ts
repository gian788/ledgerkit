import { randomUUID } from 'crypto';
import path from 'path';
import knex, { type Knex } from 'knex';
import { types as pgTypes } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Producer } from 'kafkajs';
import { OutboxEventType } from '@ledger/shared';
import { pollOnce } from '../../relay';

pgTypes.setTypeParser(20, BigInt);

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../migrations');

let db: Knex;
let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  db = knex({ client: 'pg', connection: container.getConnectionUri() });
  await db.migrate.latest({ directory: MIGRATIONS_DIR, loadExtensions: ['.ts'] });
}, 90_000);

afterAll(async () => {
  await db.destroy();
  await container.stop();
});

beforeEach(async () => {
  await db.raw(
    'TRUNCATE outbox, journal_lines, journal_entries, transactions, wallets, users, organisations RESTART IDENTITY CASCADE',
  );
});

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedTransaction() {
  const orgId = randomUUID();
  const srcId = randomUUID();
  const dstId = randomUUID();
  const txId = randomUUID();

  await db('organisations').insert({
    id: orgId,
    name: 'Test',
    jurisdiction: 'GB',
    residency: 'GB',
  });
  await db('wallets').insert([
    { id: srcId, organisation_id: orgId, currency: 'GBP', balance: 10_000, pending_amount: 1_000 },
    { id: dstId, organisation_id: orgId, currency: 'GBP', balance: 0, pending_amount: 0 },
  ]);
  await db('transactions').insert({
    id: txId,
    idempotency_key: randomUUID(),
    source_wallet_id: srcId,
    destination_wallet_id: dstId,
    amount: 1_000,
    currency: 'GBP',
    status: 'PENDING',
  });

  return { orgId, srcId, dstId, txId };
}

async function insertOutboxRow(
  txId: string,
  type: OutboxEventType,
  payload: Record<string, unknown>,
) {
  const id = randomUUID();
  await db('outbox').insert({
    id,
    type,
    transaction_id: txId,
    payload: JSON.stringify(payload),
    published: false,
  });
  return id;
}

function makeMockProducer() {
  const mockSend = jest.fn().mockResolvedValue([]);
  return { producer: { send: mockSend } as unknown as Producer, mockSend };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

it('publishes unpublished rows and marks them as published', async () => {
  const { txId, dstId } = await seedTransaction();
  const settlementPayload = {
    transaction_id: txId,
    destination_wallet_id: dstId,
    amount: 1000,
    currency: 'GBP',
  };
  const outboxId = await insertOutboxRow(txId, OutboxEventType.SETTLEMENT, settlementPayload);

  const { producer, mockSend } = makeMockProducer();
  await pollOnce(db, producer);

  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({ messages: [expect.objectContaining({ key: dstId })] }),
  );

  const row = await db('outbox').where({ id: outboxId }).first();
  expect(row.published).toBe(true);
  expect(row.published_at).not.toBeNull();
});

it('does not re-publish already published rows', async () => {
  const { txId } = await seedTransaction();
  await insertOutboxRow(txId, OutboxEventType.SETTLEMENT, { transaction_id: txId });
  const { producer, mockSend } = makeMockProducer();

  await pollOnce(db, producer); // first poll — publishes
  await pollOnce(db, producer); // second poll — nothing left

  expect(mockSend).toHaveBeenCalledTimes(1);
});

it('publishes both SETTLEMENT and AUDIT rows for the same transaction', async () => {
  const { txId, dstId } = await seedTransaction();
  await insertOutboxRow(txId, OutboxEventType.SETTLEMENT, {
    transaction_id: txId,
    destination_wallet_id: dstId,
  });
  await insertOutboxRow(txId, OutboxEventType.AUDIT, {
    event: 'TRANSACTION_CREATED',
    resource_id: txId,
  });

  const { producer, mockSend } = makeMockProducer();
  await pollOnce(db, producer);

  expect(mockSend).toHaveBeenCalledTimes(2);

  const topics = mockSend.mock.calls.map((c) => (c[0] as { topic: string }).topic);
  expect(topics).toContain('transactions.pending');
  expect(topics).toContain('audit.events');

  const published = await db('outbox').where({ transaction_id: txId }).select('published');
  expect(published.every((r: { published: boolean }) => r.published)).toBe(true);
});

it('does not mark a row published when the Kafka send fails', async () => {
  const { txId } = await seedTransaction();
  const outboxId = await insertOutboxRow(txId, OutboxEventType.SETTLEMENT, {
    transaction_id: txId,
    destination_wallet_id: 'wallet-x',
  });

  const failingProducer = {
    send: jest.fn().mockRejectedValue(new Error('broker down')),
  } as unknown as Producer;

  await expect(pollOnce(db, failingProducer)).rejects.toThrow('broker down');

  const row = await db('outbox').where({ id: outboxId }).first();
  expect(row.published).toBe(false);
});
