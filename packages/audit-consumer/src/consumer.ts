import type { AuditStorage, AuditEvent } from './storage';

/**
 * Processes a single raw Kafka message value (the outbox payload JSON string)
 * by parsing it and writing to the audit storage. Pure function — no Kafka
 * dependency, so it is unit-testable in isolation.
 */
export async function processAuditMessage(
  rawValue: string,
  storage: AuditStorage,
): Promise<void> {
  const payload = JSON.parse(rawValue) as Record<string, unknown>;

  if (
    typeof payload['event'] !== 'string' ||
    typeof payload['resource_type'] !== 'string' ||
    typeof payload['resource_id'] !== 'string'
  ) {
    throw new Error(`Invalid audit payload — missing required fields: ${rawValue}`);
  }

  const event: AuditEvent = {
    event: payload['event'],
    resource_type: payload['resource_type'],
    resource_id: payload['resource_id'],
    received_at: new Date().toISOString(),
  };

  if (payload['before'] !== undefined) {
    event.before = payload['before'] as Record<string, unknown>;
  }
  if (payload['after'] !== undefined) {
    event.after = payload['after'] as Record<string, unknown>;
  }

  await storage.writeEvent(event);
}
