/**
 * Full pipeline E2E tests.
 *
 * Requires the docker-compose stack to be running:
 *   docker-compose up -d
 *
 * All four services run in-process against the live containers:
 *   API (Express/supertest) → outbox relay (pollOnce loop) →
 *   Kafka → settlement worker (eachBatch) → DB
 *   Kafka → audit consumer (eachMessage) → S3 (MinIO)
 *
 * For CI: add a step that runs `docker-compose up -d` before this suite.
 */

import knex, { type Knex } from 'knex';
import { types as pgTypes } from 'pg';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { Kafka, Partitioners, type Consumer, type Producer } from 'kafkajs';
import request from 'supertest';
import { randomUUID } from 'crypto';

import { createApp } from '@ledger/api/app';
import { pollOnce } from '@ledger/outbox-relay/relay';
import { settleBatch, type SettlementPayload } from '@ledger/settlement-worker/settler';
import { processAuditMessage } from '@ledger/audit-consumer/consumer';
import { S3AuditStorage, makeS3Client } from '@ledger/audit-consumer/storage';

pgTypes.setTypeParser(20, BigInt);

const AUDIT_BUCKET = 'ledger-audit-e2e';

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://ledger:ledger@localhost:5432/ledger';
const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const S3_ENDPOINT = process.env['S3_ENDPOINT'] ?? 'http://localhost:9000';

// ── Shared state ───────────────────────────────────────────────────────────────

let db: Knex;
let s3: S3Client;
let s3Storage: S3AuditStorage;
let app: ReturnType<typeof createApp>;

let producer: Producer;
let swConsumer: Consumer;
let auditConsumer: Consumer;

let relayRunning = false;
let relayPromise: Promise<void>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for: ${label}`);
}

async function s3ObjectsForResource(resourceId: string) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: AUDIT_BUCKET }));
  return (list.Contents ?? []).filter((o) => o.Key?.includes(resourceId));
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Database
  db = knex({ client: 'pg', connection: DB_URL });

  // S3 / MinIO
  s3 = makeS3Client({
    endpoint: S3_ENDPOINT,
    region: 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'minioadmin',
    secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'minioadmin',
    forcePathStyle: true,
  });
  s3Storage = new S3AuditStorage(s3, AUDIT_BUCKET);
  await s3Storage.ensureBucket();

  // Kafka clients
  const kafka = new Kafka({
    clientId: 'e2e-test',
    brokers: KAFKA_BROKERS,
    retry: { retries: 5 },
  });

  // Create topics explicitly so consumers can subscribe before any messages arrive.
  // Kafka auto-creates on first produce, but subscribing to a non-existent topic
  // throws UNKNOWN_TOPIC_OR_PARTITION on the metadata request.
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      { topic: 'transactions.pending', numPartitions: 12, replicationFactor: 1 },
      { topic: 'audit.events', numPartitions: 1, replicationFactor: 1 },
    ],
  });
  await admin.disconnect();

  producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
  await producer.connect();

  // Settlement worker consumer — unique group so each run starts fresh
  swConsumer = kafka.consumer({ groupId: `e2e-settlement-${randomUUID()}` });
  await swConsumer.connect();
  await swConsumer.subscribe({ topic: 'transactions.pending', fromBeginning: true });
  void swConsumer.run({
    eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
      const items = batch.messages
        .filter((m) => m.value)
        .map((m) => JSON.parse(m.value!.toString()) as SettlementPayload);
      if (items.length > 0) await settleBatch(db, items);
      for (const m of batch.messages) resolveOffset(m.offset);
      await heartbeat();
    },
  });

  // Audit consumer
  auditConsumer = kafka.consumer({ groupId: `e2e-audit-${randomUUID()}` });
  await auditConsumer.connect();
  await auditConsumer.subscribe({ topic: 'audit.events', fromBeginning: true });
  void auditConsumer.run({
    eachMessage: async ({ message }) => {
      if (message.value) {
        await processAuditMessage(message.value.toString(), s3Storage).catch(console.error);
      }
    },
  });

  // API
  app = createApp(db);

  // Outbox relay polling loop
  relayRunning = true;
  relayPromise = (async () => {
    while (relayRunning) {
      await pollOnce(db, producer);
      await sleep(300);
    }
  })();
}, 30_000);

afterAll(async () => {
  relayRunning = false;
  if (relayPromise) await relayPromise;

  await producer?.disconnect();
  await swConsumer?.disconnect();
  await auditConsumer?.disconnect();
  await db?.destroy();
}, 15_000);

beforeEach(async () => {
  await db.raw(
    'TRUNCATE outbox, journal_lines, journal_entries, transactions, wallets, users, organisations RESTART IDENTITY CASCADE',
  );
});

// ── Scenario helpers ──────────────────────────────────────────────────────────

async function createOrg() {
  const res = await request(app)
    .post('/organisations')
    .send({ name: 'Acme', jurisdiction: 'GB', residency: 'GB' });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function createWallet(orgId: string, currency = 'GBP') {
  const res = await request(app).post(`/organisations/${orgId}/accounts`).send({ currency });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function fundWallet(walletId: string, amount: number) {
  await db('wallets').where({ id: walletId }).update({ balance: amount });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

it('settles a transaction end-to-end: balances correct, audit event in S3', async () => {
  const orgId = await createOrg();
  const srcId = await createWallet(orgId);
  const dstId = await createWallet(orgId);
  await fundWallet(srcId, 10_000);

  const createRes = await request(app)
    .post(`/organisations/${orgId}/transactions`)
    .send({
      idempotency_key: `e2e-full-${randomUUID()}`,
      source_wallet_id: srcId,
      destination_wallet_id: dstId,
      amount: 3_000,
      currency: 'GBP',
    });
  expect(createRes.status).toBe(201);
  const txId = (createRes.body as { id: string }).id;
  expect(createRes.body.status).toBe('PENDING');

  // Wait for settlement worker to flip the transaction to SETTLED
  await waitFor(
    async () => (await db('transactions').where({ id: txId }).first())?.status === 'SETTLED',
    'transaction SETTLED',
  );

  // ── Balance assertions ────────────────────────────────────────────────────
  const src = await db('wallets').where({ id: srcId }).first();
  const dst = await db('wallets').where({ id: dstId }).first();

  expect(BigInt(src.balance)).toBe(BigInt(7_000)); // 10000 - 3000
  expect(BigInt(src.pending_amount)).toBe(BigInt(0));
  expect(BigInt(dst.balance)).toBe(BigInt(3_000));

  // ── Journal entry (double-entry balanced) ─────────────────────────────────
  const [entry] = await db('journal_entries').where({ transaction_id: txId });
  expect(entry).toBeDefined();
  const lines = await db('journal_lines').where({ journal_entry_id: entry.id });
  expect(lines).toHaveLength(2);
  const debit = BigInt(lines.find((l: { direction: string }) => l.direction === 'DEBIT').amount);
  const credit = BigInt(lines.find((l: { direction: string }) => l.direction === 'CREDIT').amount);
  expect(debit).toBe(credit);

  // ── TRANSACTION_CREATED audit event must appear in S3 ────────────────────
  await waitFor(
    async () => (await s3ObjectsForResource(txId)).length >= 1,
    'TRANSACTION_CREATED audit event in S3',
  );

  const auditObjects = await s3ObjectsForResource(txId);
  const createdKey = auditObjects.find((o) => o.Key?.includes('TRANSACTION_CREATED'))?.Key;
  expect(createdKey).toBeDefined();

  const obj = await s3.send(new GetObjectCommand({ Bucket: AUDIT_BUCKET, Key: createdKey! }));
  const parsed = JSON.parse(await obj.Body!.transformToString());
  expect(parsed.event).toBe('TRANSACTION_CREATED');
  expect(parsed.resource_id).toBe(txId);
  expect(parsed.after.status).toBe('PENDING');
});

it('cancels a transaction: funds released, both audit events land in S3', async () => {
  const orgId = await createOrg();
  const srcId = await createWallet(orgId);
  const dstId = await createWallet(orgId);
  await fundWallet(srcId, 5_000);

  const createRes = await request(app)
    .post(`/organisations/${orgId}/transactions`)
    .send({
      idempotency_key: `e2e-cancel-${randomUUID()}`,
      source_wallet_id: srcId,
      destination_wallet_id: dstId,
      amount: 2_000,
      currency: 'GBP',
    });
  expect(createRes.status).toBe(201);
  const txId = (createRes.body as { id: string }).id;

  const cancelRes = await request(app).post(`/transactions/${txId}/cancel`);
  expect(cancelRes.status).toBe(200);
  expect(cancelRes.body.status).toBe('CANCELLED');

  // Source balance immediately restored (cancel is synchronous DB op)
  const src = await db('wallets').where({ id: srcId }).first();
  expect(BigInt(src.balance)).toBe(BigInt(5_000));
  expect(BigInt(src.pending_amount)).toBe(BigInt(0));

  // Settlement worker must skip the CANCELLED transaction — wait then confirm
  await sleep(3_000);
  expect((await db('transactions').where({ id: txId }).first()).status).toBe('CANCELLED');

  // Two S3 audit events: TRANSACTION_CREATED + TRANSACTION_CANCELLED
  await waitFor(
    async () => (await s3ObjectsForResource(txId)).length >= 2,
    '2 audit events for cancelled transaction',
  );

  const auditObjects = await s3ObjectsForResource(txId);
  const events = await Promise.all(
    auditObjects.map(async (o) => {
      const obj = await s3.send(new GetObjectCommand({ Bucket: AUDIT_BUCKET, Key: o.Key! }));
      return JSON.parse(await obj.Body!.transformToString()) as {
        event: string;
        before?: unknown;
        after?: unknown;
      };
    }),
  );

  const eventNames = events.map((e) => e.event).sort();
  expect(eventNames).toEqual(['TRANSACTION_CANCELLED', 'TRANSACTION_CREATED']);

  const cancelledEvent = events.find((e) => e.event === 'TRANSACTION_CANCELLED')!;
  expect(cancelledEvent.before).toEqual({ status: 'PENDING' });
  expect(cancelledEvent.after).toEqual({ status: 'CANCELLED' });
});
