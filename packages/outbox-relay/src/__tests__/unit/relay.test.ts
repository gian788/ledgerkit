import type { Knex } from 'knex';
import type { Producer } from 'kafkajs';
import { OutboxEventType, config } from '@ledger/shared';
import type { OutboxRow } from '@ledger/shared';
import { getTopicForRow, getKeyForRow, pollOnce, BATCH_SIZE } from '../../relay';

// ── Fixtures ────────────────────────────────────────────────────────────────

const SETTLEMENT_ROW: OutboxRow = {
  id: 'outbox-1',
  type: OutboxEventType.SETTLEMENT,
  transaction_id: 'tx-1',
  payload: {
    transaction_id: 'tx-1',
    source_wallet_id: 'wallet-1',
    destination_wallet_id: 'wallet-2',
    amount: 1000,
    currency: 'GBP',
  },
  published: false,
  created_at: new Date(),
  published_at: null,
};

const AUDIT_ROW: OutboxRow = {
  id: 'outbox-2',
  type: OutboxEventType.AUDIT,
  transaction_id: 'tx-1',
  payload: {
    event: 'TRANSACTION_CREATED',
    resource_type: 'transaction',
    resource_id: 'tx-1',
    after: {},
  },
  published: false,
  created_at: new Date(),
  published_at: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDb(rows: OutboxRow[]) {
  const mockUpdate = jest.fn().mockResolvedValue(1);
  const mockUpdateWhere = jest.fn().mockReturnValue({ update: mockUpdate });

  const mockLimit = jest.fn().mockResolvedValue(rows);
  const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
  const mockSelectWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });

  // First call → SELECT chain; subsequent calls → UPDATE chain (one per row)
  const mockTable = jest
    .fn()
    .mockReturnValueOnce({ where: mockSelectWhere })
    .mockReturnValue({ where: mockUpdateWhere });

  return {
    db: mockTable as unknown as Knex,
    mockSelectWhere,
    mockOrderBy,
    mockLimit,
    mockUpdateWhere,
    mockUpdate,
  };
}

function makeMockProducer() {
  const mockSend = jest.fn().mockResolvedValue([]);
  return { producer: { send: mockSend } as unknown as Producer, mockSend };
}

// ── getTopicForRow ────────────────────────────────────────────────────────────

describe('getTopicForRow', () => {
  it('routes SETTLEMENT to the transactions topic', () => {
    expect(getTopicForRow(OutboxEventType.SETTLEMENT)).toBe(config.kafka.topics.transactions);
  });

  it('routes AUDIT to the audit topic', () => {
    expect(getTopicForRow(OutboxEventType.AUDIT)).toBe(config.kafka.topics.audit);
  });
});

// ── getKeyForRow ──────────────────────────────────────────────────────────────

describe('getKeyForRow', () => {
  it('uses destination_wallet_id as key for SETTLEMENT rows', () => {
    expect(getKeyForRow(SETTLEMENT_ROW)).toBe('wallet-2');
  });

  it('uses transaction_id as key for AUDIT rows', () => {
    expect(getKeyForRow(AUDIT_ROW)).toBe('tx-1');
  });
});

// ── pollOnce ──────────────────────────────────────────────────────────────────

describe('pollOnce', () => {
  it('does nothing when the outbox is empty', async () => {
    const { db } = makeMockDb([]);
    const { producer, mockSend } = makeMockProducer();

    await pollOnce(db, producer);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('queries unpublished rows ordered by created_at with the correct batch limit', async () => {
    const { db, mockSelectWhere, mockOrderBy, mockLimit } = makeMockDb([]);

    await pollOnce(db, { send: jest.fn().mockResolvedValue([]) } as unknown as Producer);

    expect(mockSelectWhere).toHaveBeenCalledWith({ published: false });
    expect(mockOrderBy).toHaveBeenCalledWith('created_at', 'asc');
    expect(mockLimit).toHaveBeenCalledWith(BATCH_SIZE);
  });

  it('sends a SETTLEMENT row to the correct topic with destination_wallet_id as key', async () => {
    const { db } = makeMockDb([SETTLEMENT_ROW]);
    const { producer, mockSend } = makeMockProducer();

    await pollOnce(db, producer);

    expect(mockSend).toHaveBeenCalledWith({
      topic: config.kafka.topics.transactions,
      messages: [
        {
          key: 'wallet-2',
          value: JSON.stringify(SETTLEMENT_ROW.payload),
        },
      ],
    });
  });

  it('sends an AUDIT row to the correct topic with transaction_id as key', async () => {
    const { db } = makeMockDb([AUDIT_ROW]);
    const { producer, mockSend } = makeMockProducer();

    await pollOnce(db, producer);

    expect(mockSend).toHaveBeenCalledWith({
      topic: config.kafka.topics.audit,
      messages: [
        {
          key: 'tx-1',
          value: JSON.stringify(AUDIT_ROW.payload),
        },
      ],
    });
  });

  it('marks each row published after sending', async () => {
    const { db, mockUpdateWhere, mockUpdate } = makeMockDb([SETTLEMENT_ROW]);
    const { producer } = makeMockProducer();

    await pollOnce(db, producer);

    expect(mockUpdateWhere).toHaveBeenCalledWith({ id: SETTLEMENT_ROW.id });
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ published: true }));
  });

  it('processes multiple rows in order and marks each published', async () => {
    const { db, mockUpdate } = makeMockDb([SETTLEMENT_ROW, AUDIT_ROW]);
    const { producer, mockSend } = makeMockProducer();

    await pollOnce(db, producer);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not mark a row published if the Kafka send throws', async () => {
    const { db, mockUpdate } = makeMockDb([SETTLEMENT_ROW]);
    const failingProducer = {
      send: jest.fn().mockRejectedValue(new Error('broker unavailable')),
    } as unknown as Producer;

    await expect(pollOnce(db, failingProducer)).rejects.toThrow('broker unavailable');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
