import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import knex, { type Knex } from 'knex';
import { types as pgTypes } from 'pg';
import path from 'path';
import { randomUUID } from 'crypto';
import { TransactionStatus, JournalLineDirection } from '@ledger/shared';
import { settleBatch, type SettlementPayload } from '../../settler';

pgTypes.setTypeParser(20, BigInt);

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../migrations');

// ── Helpers ────────────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let db: Knex;

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

interface SeedResult {
  orgId: string;
  srcWalletId: string;
  dstWalletId: string;
  txId: string;
  payload: SettlementPayload;
}

async function seed(amount = 1000, currency = 'GBP'): Promise<SeedResult> {
  const orgId = randomUUID();
  await db('organisations').insert({
    id: orgId,
    name: 'Test Org',
    jurisdiction: 'GB',
    residency: 'GB',
  });

  const srcWalletId = randomUUID();
  const dstWalletId = randomUUID();
  await db('wallets').insert([
    { id: srcWalletId, organisation_id: orgId, currency, balance: 10_000, pending_amount: amount },
    { id: dstWalletId, organisation_id: orgId, currency, balance: 5_000, pending_amount: 0 },
  ]);

  const txId = randomUUID();
  await db('transactions').insert({
    id: txId,
    idempotency_key: randomUUID(),
    source_wallet_id: srcWalletId,
    destination_wallet_id: dstWalletId,
    amount,
    currency,
    status: TransactionStatus.PENDING,
  });

  return {
    orgId,
    srcWalletId,
    dstWalletId,
    txId,
    payload: {
      transaction_id: txId,
      source_wallet_id: srcWalletId,
      destination_wallet_id: dstWalletId,
      amount,
      currency,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

it('settles a PENDING transaction: status, journal, wallet balances', async () => {
  const { payload, txId, srcWalletId, dstWalletId } = await seed(1000);

  await settleBatch(db, [payload]);

  // Transaction is SETTLED
  const [tx] = await db('transactions').where({ id: txId });
  expect(tx.status).toBe(TransactionStatus.SETTLED);
  expect(tx.settled_at).not.toBeNull();

  // One journal entry with two balanced lines
  const [entry] = await db('journal_entries').where({ transaction_id: txId });
  expect(entry).toBeDefined();

  const lines = await db('journal_lines').where({ journal_entry_id: entry.id });
  expect(lines).toHaveLength(2);

  const debit = lines.find((l: { direction: string }) => l.direction === JournalLineDirection.DEBIT);
  const credit = lines.find((l: { direction: string }) => l.direction === JournalLineDirection.CREDIT);
  expect(debit?.wallet_id).toBe(srcWalletId);
  expect(credit?.wallet_id).toBe(dstWalletId);
  expect(BigInt(debit?.amount)).toBe(BigInt(credit?.amount)); // double-entry balance

  // Source wallet: balance decremented, pending_amount released
  const [src] = await db('wallets').where({ id: srcWalletId });
  expect(BigInt(src.balance)).toBe(BigInt(10_000 - 1000));
  expect(BigInt(src.pending_amount)).toBe(BigInt(0));

  // Destination wallet: balance incremented
  const [dst] = await db('wallets').where({ id: dstWalletId });
  expect(BigInt(dst.balance)).toBe(BigInt(5_000 + 1000));
  expect(BigInt(dst.pending_amount)).toBe(BigInt(0));
});

it('is idempotent: re-settling a SETTLED transaction is a no-op', async () => {
  const { payload, txId, srcWalletId, dstWalletId } = await seed(1000);

  await settleBatch(db, [payload]); // first pass — settles
  await settleBatch(db, [payload]); // second pass — idempotency guard skips it

  // Still exactly one journal entry
  const entries = await db('journal_entries').where({ transaction_id: txId });
  expect(entries).toHaveLength(1);

  // Balances applied exactly once
  const [src] = await db('wallets').where({ id: srcWalletId });
  const [dst] = await db('wallets').where({ id: dstWalletId });
  expect(BigInt(src.balance)).toBe(BigInt(9_000));
  expect(BigInt(dst.balance)).toBe(BigInt(6_000));
});

it('skips a CANCELLED transaction without touching balances', async () => {
  const { payload, txId, srcWalletId, dstWalletId } = await seed(1000);

  // Cancel it before the worker processes it
  await db('transactions').where({ id: txId }).update({
    status: TransactionStatus.CANCELLED,
    settled_at: null,
  });
  // Also release the pending_amount that a cancel handler would have released
  await db('wallets').where({ id: srcWalletId }).update({ pending_amount: 0 });

  await settleBatch(db, [payload]);

  // Transaction remains CANCELLED
  const [tx] = await db('transactions').where({ id: txId });
  expect(tx.status).toBe(TransactionStatus.CANCELLED);

  // No journal entries
  const entries = await db('journal_entries').where({ transaction_id: txId });
  expect(entries).toHaveLength(0);

  // Balances unchanged
  const [src] = await db('wallets').where({ id: srcWalletId });
  const [dst] = await db('wallets').where({ id: dstWalletId });
  expect(BigInt(src.balance)).toBe(BigInt(10_000));
  expect(BigInt(dst.balance)).toBe(BigInt(5_000));
});

it('settles a multi-item batch with same destination in one DB transaction', async () => {
  const orgId = randomUUID();
  await db('organisations').insert({ id: orgId, name: 'Org', jurisdiction: 'GB', residency: 'GB' });

  const src1Id = randomUUID();
  const src2Id = randomUUID();
  const dstId = randomUUID();
  await db('wallets').insert([
    { id: src1Id, organisation_id: orgId, currency: 'GBP', balance: 5_000, pending_amount: 1_000 },
    { id: src2Id, organisation_id: orgId, currency: 'GBP', balance: 5_000, pending_amount: 2_000 },
    { id: dstId, organisation_id: orgId, currency: 'GBP', balance: 0, pending_amount: 0 },
  ]);

  const tx1Id = randomUUID();
  const tx2Id = randomUUID();
  await db('transactions').insert([
    {
      id: tx1Id,
      idempotency_key: randomUUID(),
      source_wallet_id: src1Id,
      destination_wallet_id: dstId,
      amount: 1_000,
      currency: 'GBP',
      status: TransactionStatus.PENDING,
    },
    {
      id: tx2Id,
      idempotency_key: randomUUID(),
      source_wallet_id: src2Id,
      destination_wallet_id: dstId,
      amount: 2_000,
      currency: 'GBP',
      status: TransactionStatus.PENDING,
    },
  ]);

  await settleBatch(db, [
    { transaction_id: tx1Id, source_wallet_id: src1Id, destination_wallet_id: dstId, amount: 1_000, currency: 'GBP' },
    { transaction_id: tx2Id, source_wallet_id: src2Id, destination_wallet_id: dstId, amount: 2_000, currency: 'GBP' },
  ]);

  // Both transactions settled
  const txs = await db('transactions').whereIn('id', [tx1Id, tx2Id]);
  expect(txs.every((t: { status: string }) => t.status === TransactionStatus.SETTLED)).toBe(true);

  // Two journal entries, four lines
  const entries = await db('journal_entries').whereIn('transaction_id', [tx1Id, tx2Id]);
  expect(entries).toHaveLength(2);

  // Destination receives combined amount in one update (net result: balance = 3000)
  const [dst] = await db('wallets').where({ id: dstId });
  expect(BigInt(dst.balance)).toBe(BigInt(3_000));
});

it('processes separate destination groups independently', async () => {
  const orgId = randomUUID();
  await db('organisations').insert({ id: orgId, name: 'Org', jurisdiction: 'GB', residency: 'GB' });

  const srcId = randomUUID();
  const dst1Id = randomUUID();
  const dst2Id = randomUUID();
  await db('wallets').insert([
    { id: srcId, organisation_id: orgId, currency: 'GBP', balance: 10_000, pending_amount: 1_500 },
    { id: dst1Id, organisation_id: orgId, currency: 'GBP', balance: 0, pending_amount: 0 },
    { id: dst2Id, organisation_id: orgId, currency: 'GBP', balance: 0, pending_amount: 0 },
  ]);

  const tx1Id = randomUUID();
  const tx2Id = randomUUID();
  await db('transactions').insert([
    {
      id: tx1Id,
      idempotency_key: randomUUID(),
      source_wallet_id: srcId,
      destination_wallet_id: dst1Id,
      amount: 500,
      currency: 'GBP',
      status: TransactionStatus.PENDING,
    },
    {
      id: tx2Id,
      idempotency_key: randomUUID(),
      source_wallet_id: srcId,
      destination_wallet_id: dst2Id,
      amount: 1_000,
      currency: 'GBP',
      status: TransactionStatus.PENDING,
    },
  ]);

  await settleBatch(db, [
    { transaction_id: tx1Id, source_wallet_id: srcId, destination_wallet_id: dst1Id, amount: 500, currency: 'GBP' },
    { transaction_id: tx2Id, source_wallet_id: srcId, destination_wallet_id: dst2Id, amount: 1_000, currency: 'GBP' },
  ]);

  const [dst1] = await db('wallets').where({ id: dst1Id });
  const [dst2] = await db('wallets').where({ id: dst2Id });
  expect(BigInt(dst1.balance)).toBe(BigInt(500));
  expect(BigInt(dst2.balance)).toBe(BigInt(1_000));
});
