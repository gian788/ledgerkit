import type { Knex } from 'knex';
import { TransactionStatus, JournalLineDirection } from '@ledger/shared';
import { settleBatch, type SettlementPayload } from '../../settler';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TX: SettlementPayload = {
  transaction_id: 'tx-1',
  source_wallet_id: 'wallet-src',
  destination_wallet_id: 'wallet-dst',
  amount: 1000,
  currency: 'GBP',
};

const TX2: SettlementPayload = {
  transaction_id: 'tx-2',
  source_wallet_id: 'wallet-src-2',
  destination_wallet_id: 'wallet-dst',
  amount: 500,
  currency: 'GBP',
};

const TX_OTHER_DEST: SettlementPayload = {
  transaction_id: 'tx-3',
  source_wallet_id: 'wallet-src-3',
  destination_wallet_id: 'wallet-dst-2',
  amount: 200,
  currency: 'EUR',
};

// ── Mock builder ──────────────────────────────────────────────────────────────

/**
 * Builds a mock Knex instance backed by a per-table call sequence.
 * Each table gets its own ordered list of return values, consumed by
 * .mockReturnValueOnce so that successive calls to db('table') return the
 * next value in the list.
 */
function makeMockDb(tableReturns: Record<string, unknown[]>) {
  const counters: Record<string, number> = {};
  const mocks: Record<string, jest.Mock> = {};

  const dbFn = jest.fn().mockImplementation((table: string) => {
    const returns = tableReturns[table] ?? [];
    const idx = counters[table] ?? 0;
    counters[table] = idx + 1;
    return returns[idx] ?? returns[returns.length - 1] ?? {};
  });

  // transaction() shim — runs the callback immediately with the same db
  (dbFn as unknown as Knex).transaction = jest.fn().mockImplementation(
    async (cb: (trx: Knex) => Promise<void>) => cb(dbFn as unknown as Knex),
  );
  (dbFn as unknown as Knex).raw = jest.fn().mockReturnValue('__raw__');
  (dbFn as unknown as Knex).fn = { now: jest.fn().mockReturnValue('__now__') } as unknown as Knex['fn'];

  return { db: dbFn as unknown as Knex, mocks, dbFn };
}

function makeSettledChain() {
  const update = jest.fn().mockResolvedValue(undefined);
  const returning = jest.fn().mockResolvedValue([{ id: 'tx-1' }]);
  update.mockReturnValue({ returning });
  const where = jest.fn().mockReturnValue({ update });
  return { where, update, returning };
}

function makeSkippedChain() {
  const returning = jest.fn().mockResolvedValue([]); // no rows → already handled
  const update = jest.fn().mockReturnValue({ returning });
  const where = jest.fn().mockReturnValue({ update });
  return { where, update, returning };
}

function makeInsertChain() {
  const insert = jest.fn().mockResolvedValue(undefined);
  return { insert, where: jest.fn().mockReturnValue({ update: jest.fn().mockResolvedValue(1), insert }) };
}

function makeWalletUpdateChain() {
  const update = jest.fn().mockResolvedValue(1);
  const where = jest.fn().mockReturnValue({ update });
  return { where, update };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

it('does nothing for an empty batch', async () => {
  const { db, dbFn } = makeMockDb({});
  await settleBatch(db, []);
  expect(dbFn).not.toHaveBeenCalled();
});

it('skips a transaction that is no longer PENDING', async () => {
  const skippedChain = makeSkippedChain();
  const insertEntry = jest.fn().mockResolvedValue(undefined);
  const insertLines = jest.fn().mockResolvedValue(undefined);
  const walletUpdate = makeWalletUpdateChain();

  const dbFn = jest.fn().mockImplementation((table: string) => {
    if (table === 'transactions') return skippedChain;
    if (table === 'journal_entries') return { insert: insertEntry };
    if (table === 'journal_lines') return { insert: insertLines };
    if (table === 'wallets') return walletUpdate;
    return {};
  });
  (dbFn as unknown as Knex).transaction = jest.fn().mockImplementation(
    async (cb: (trx: Knex) => Promise<void>) => cb(dbFn as unknown as Knex),
  );
  (dbFn as unknown as Knex).raw = jest.fn().mockReturnValue('__raw__');
  (dbFn as unknown as Knex).fn = { now: jest.fn() } as unknown as Knex['fn'];

  await settleBatch(dbFn as unknown as Knex, [TX]);

  expect(insertEntry).not.toHaveBeenCalled();
  expect(insertLines).not.toHaveBeenCalled();
  expect(walletUpdate.update).not.toHaveBeenCalled();
});

it('settles a transaction: marks SETTLED, inserts journal entry+lines, updates wallets', async () => {
  const txChain = makeSettledChain();
  const entryInsert = jest.fn().mockResolvedValue(undefined);
  const linesInsert = jest.fn().mockResolvedValue(undefined);
  const walletUpdate = makeWalletUpdateChain();

  const dbFn = jest.fn().mockImplementation((table: string) => {
    if (table === 'transactions') return txChain;
    if (table === 'journal_entries') return { insert: entryInsert };
    if (table === 'journal_lines') return { insert: linesInsert };
    if (table === 'wallets') return walletUpdate;
    return {};
  });
  (dbFn as unknown as Knex).transaction = jest.fn().mockImplementation(
    async (cb: (trx: Knex) => Promise<void>) => cb(dbFn as unknown as Knex),
  );
  (dbFn as unknown as Knex).raw = jest.fn().mockReturnValue('__raw__');
  (dbFn as unknown as Knex).fn = { now: jest.fn() } as unknown as Knex['fn'];

  await settleBatch(dbFn as unknown as Knex, [TX]);

  // Transaction marked SETTLED
  expect(txChain.where).toHaveBeenCalledWith({
    id: TX.transaction_id,
    status: TransactionStatus.PENDING,
  });
  expect(txChain.update).toHaveBeenCalledWith(
    expect.objectContaining({ status: TransactionStatus.SETTLED }),
  );

  // Journal entry inserted
  expect(entryInsert).toHaveBeenCalledWith(
    expect.objectContaining({ transaction_id: TX.transaction_id }),
  );

  // Two journal lines: one DEBIT, one CREDIT
  const [lines] = linesInsert.mock.calls[0] as [Array<{ direction: string; wallet_id: string }>];
  expect(lines).toHaveLength(2);
  expect(lines.find((l) => l.direction === JournalLineDirection.DEBIT)?.wallet_id).toBe(
    TX.source_wallet_id,
  );
  expect(lines.find((l) => l.direction === JournalLineDirection.CREDIT)?.wallet_id).toBe(
    TX.destination_wallet_id,
  );

  // Source wallet decremented; destination wallet incremented
  expect(walletUpdate.where).toHaveBeenCalledWith({ id: TX.source_wallet_id });
  expect(walletUpdate.where).toHaveBeenCalledWith({ id: TX.destination_wallet_id });
  expect(walletUpdate.update).toHaveBeenCalledTimes(2);
});

it('groups two transactions for the same destination into one DB transaction', async () => {
  const txChain = makeSettledChain();
  // Both tx-1 and tx-2 point to the same destination — should be one trx call
  txChain.returning.mockResolvedValueOnce([{ id: 'tx-1' }]).mockResolvedValueOnce([{ id: 'tx-2' }]);
  const entryInsert = jest.fn().mockResolvedValue(undefined);
  const linesInsert = jest.fn().mockResolvedValue(undefined);
  const walletUpdate = makeWalletUpdateChain();
  const transactionSpy = jest.fn().mockImplementation(
    async (cb: (trx: Knex) => Promise<void>) => cb(dbFn as unknown as Knex),
  );

  const dbFn = jest.fn().mockImplementation((table: string) => {
    if (table === 'transactions') return txChain;
    if (table === 'journal_entries') return { insert: entryInsert };
    if (table === 'journal_lines') return { insert: linesInsert };
    if (table === 'wallets') return walletUpdate;
    return {};
  });
  (dbFn as unknown as Knex).transaction = transactionSpy;
  (dbFn as unknown as Knex).raw = jest.fn().mockReturnValue('__raw__');
  (dbFn as unknown as Knex).fn = { now: jest.fn() } as unknown as Knex['fn'];

  await settleBatch(dbFn as unknown as Knex, [TX, TX2]);

  // Both share the same destination — one DB transaction, two journal entries
  expect(transactionSpy).toHaveBeenCalledTimes(1);
  expect(entryInsert).toHaveBeenCalledTimes(2);
});

it('opens separate DB transactions for different destination wallets', async () => {
  const txChain = makeSettledChain();
  txChain.returning
    .mockResolvedValueOnce([{ id: 'tx-1' }])
    .mockResolvedValueOnce([{ id: 'tx-3' }]);
  const entryInsert = jest.fn().mockResolvedValue(undefined);
  const linesInsert = jest.fn().mockResolvedValue(undefined);
  const walletUpdate = makeWalletUpdateChain();
  const transactionSpy = jest.fn().mockImplementation(
    async (cb: (trx: Knex) => Promise<void>) => cb(dbFn as unknown as Knex),
  );

  const dbFn = jest.fn().mockImplementation((table: string) => {
    if (table === 'transactions') return txChain;
    if (table === 'journal_entries') return { insert: entryInsert };
    if (table === 'journal_lines') return { insert: linesInsert };
    if (table === 'wallets') return walletUpdate;
    return {};
  });
  (dbFn as unknown as Knex).transaction = transactionSpy;
  (dbFn as unknown as Knex).raw = jest.fn().mockReturnValue('__raw__');
  (dbFn as unknown as Knex).fn = { now: jest.fn() } as unknown as Knex['fn'];

  await settleBatch(dbFn as unknown as Knex, [TX, TX_OTHER_DEST]);

  // Different destinations → two separate DB transactions
  expect(transactionSpy).toHaveBeenCalledTimes(2);
});
