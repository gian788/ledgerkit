import type { Knex } from 'knex';
import type { Producer } from 'kafkajs';
import { OutboxEventType, config, getMeter, getTracer, injectKafkaHeaders } from '@ledger/shared';
import type { OutboxRow } from '@ledger/shared';
import { SpanStatusCode } from '@opentelemetry/api';

export const BATCH_SIZE = 100;

const meter = getMeter('outbox-relay');
const tracer = getTracer('outbox-relay');

const pollsCounter = meter.createCounter('outbox_relay_polls_total', {
  description: 'Total number of outbox poll cycles executed',
});
const rowsFetchedHisto = meter.createHistogram('outbox_relay_rows_fetched', {
  description: 'Number of outbox rows fetched per poll',
});
const publishDurationHisto = meter.createHistogram('outbox_relay_publish_duration_ms', {
  description: 'Time to publish one outbox row to Kafka (ms)',
  unit: 'ms',
});
const relayLagGauge = meter.createObservableGauge('outbox_relay_lag_seconds', {
  description: 'Age in seconds of the oldest unpublished outbox row',
  unit: 's',
});

let latestLagSeconds = 0;
relayLagGauge.addCallback((obs) => obs.observe(latestLagSeconds));

export function getTopicForRow(type: OutboxRow['type']): string {
  return type === OutboxEventType.SETTLEMENT
    ? config.kafka.topics.transactions
    : config.kafka.topics.audit;
}

export function getKeyForRow(row: Pick<OutboxRow, 'type' | 'payload' | 'transaction_id'>): string {
  return row.type === OutboxEventType.SETTLEMENT
    ? String((row.payload as { destination_wallet_id: string }).destination_wallet_id)
    : row.transaction_id;
}

export async function pollOnce(db: Knex, producer: Producer): Promise<void> {
  return tracer.startActiveSpan('outbox.poll', async (span) => {
    try {
      pollsCounter.add(1);

      const rows = await db<OutboxRow>('outbox')
        .where({ published: false })
        .orderBy('created_at', 'asc')
        .limit(BATCH_SIZE);

      rowsFetchedHisto.record(rows.length);

      if (rows.length === 0) {
        latestLagSeconds = 0;
        span.end();
        return;
      }

      // Relay lag: age of the oldest unpublished row
      const oldest = rows[0];
      latestLagSeconds =
        (Date.now() - new Date(oldest.created_at as unknown as string).getTime()) / 1000;

      // Propagate current trace context into every Kafka message so settlement
      // and audit consumers can create child spans linked to this poll span.
      const traceHeaders = injectKafkaHeaders();

      for (const row of rows) {
        const publishStart = Date.now();
        await producer.send({
          topic: getTopicForRow(row.type),
          messages: [
            {
              key: getKeyForRow(row),
              value: JSON.stringify(row.payload),
              headers: traceHeaders,
            },
          ],
        });
        publishDurationHisto.record(Date.now() - publishStart);

        // Mark published immediately after send — safe to re-run on relay restart;
        // consumers must be idempotent.
        await db('outbox')
          .where({ id: row.id })
          .update({ published: true, published_at: new Date() });
      }

      span.setAttribute('outbox.rows_published', rows.length);
      span.end();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.end();
      throw err;
    }
  });
}
