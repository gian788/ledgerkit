import type { AuditStorage, AuditEvent } from '../../storage';
import { processAuditMessage } from '../../consumer';

// ── Mock storage ──────────────────────────────────────────────────────────────

function makeMockStorage(): { storage: AuditStorage; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const storage: AuditStorage = {
    writeEvent: jest.fn(async (event: AuditEvent) => {
      events.push(event);
    }),
  };
  return { storage, events };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

it('writes a TRANSACTION_CREATED event with correct fields', async () => {
  const { storage, events } = makeMockStorage();

  await processAuditMessage(
    JSON.stringify({
      event: 'TRANSACTION_CREATED',
      resource_type: 'transaction',
      resource_id: 'tx-abc',
      after: { id: 'tx-abc', status: 'PENDING', amount: 1000 },
    }),
    storage,
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: 'TRANSACTION_CREATED',
    resource_type: 'transaction',
    resource_id: 'tx-abc',
    after: { id: 'tx-abc', status: 'PENDING', amount: 1000 },
  });
  expect(events[0]!.received_at).toBeTruthy();
  expect(events[0]!.before).toBeUndefined();
});

it('writes a TRANSACTION_CANCELLED event with before+after', async () => {
  const { storage, events } = makeMockStorage();

  await processAuditMessage(
    JSON.stringify({
      event: 'TRANSACTION_CANCELLED',
      resource_type: 'transaction',
      resource_id: 'tx-xyz',
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
    }),
    storage,
  );

  expect(events[0]).toMatchObject({
    event: 'TRANSACTION_CANCELLED',
    before: { status: 'PENDING' },
    after: { status: 'CANCELLED' },
  });
});

it('adds a received_at ISO timestamp', async () => {
  const before = Date.now();
  const { storage, events } = makeMockStorage();

  await processAuditMessage(
    JSON.stringify({ event: 'TRANSACTION_CREATED', resource_type: 'transaction', resource_id: 'x' }),
    storage,
  );

  const ts = new Date(events[0]!.received_at).getTime();
  expect(ts).toBeGreaterThanOrEqual(before);
  expect(ts).toBeLessThanOrEqual(Date.now());
});

it('throws on invalid payload missing required fields', async () => {
  const { storage } = makeMockStorage();

  await expect(
    processAuditMessage(JSON.stringify({ event: 'TRANSACTION_CREATED' }), storage),
  ).rejects.toThrow('Invalid audit payload');

  expect(storage.writeEvent).not.toHaveBeenCalled();
});

it('throws on non-JSON input', async () => {
  const { storage } = makeMockStorage();

  await expect(processAuditMessage('not-json', storage)).rejects.toThrow();
  expect(storage.writeEvent).not.toHaveBeenCalled();
});

it('propagates storage write errors', async () => {
  const storage: AuditStorage = {
    writeEvent: jest.fn().mockRejectedValue(new Error('S3 unavailable')),
  };

  await expect(
    processAuditMessage(
      JSON.stringify({ event: 'TRANSACTION_CREATED', resource_type: 'transaction', resource_id: 'x' }),
      storage,
    ),
  ).rejects.toThrow('S3 unavailable');
});
