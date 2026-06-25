import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getMeter, getTracer } from '@ledger/shared';
import { SpanStatusCode } from '@opentelemetry/api';

export interface AuditEvent {
  event: string;
  resource_type: string;
  resource_id: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  received_at: string; // ISO 8601, set by consumer at processing time
}

export interface AuditStorage {
  writeEvent(event: AuditEvent): Promise<void>;
}

const meter = getMeter('audit-consumer');
const tracer = getTracer('audit-consumer');

const s3WriteDurationHisto = meter.createHistogram('audit_s3_write_duration_ms', {
  description: 'Time to write one audit event to S3 (ms)',
  unit: 'ms',
});

/**
 * Writes audit events to S3-compatible storage as immutable JSON objects.
 * Key format: {year}/{month}/{day}/{resource_id}/{event}_{timestamp_ms}_{uuid}.json
 * In production the bucket should be configured with Object Lock (compliance mode).
 */
export class S3AuditStorage implements AuditStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async writeEvent(event: AuditEvent): Promise<void> {
    return tracer.startActiveSpan('audit.s3_write', async (span) => {
      span.setAttribute('audit.event_type', event.event);
      span.setAttribute('audit.resource_type', event.resource_type);
      span.setAttribute('audit.resource_id', event.resource_id);

      const start = Date.now();
      try {
        const ts = new Date(event.received_at);
        const year = ts.getUTCFullYear().toString();
        const month = String(ts.getUTCMonth() + 1).padStart(2, '0');
        const day = String(ts.getUTCDate()).padStart(2, '0');
        const key = `${year}/${month}/${day}/${event.resource_id}/${event.event}_${ts.getTime()}_${randomUUID()}.json`;

        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: JSON.stringify(event),
            ContentType: 'application/json',
          }),
        );

        s3WriteDurationHisto.record(Date.now() - start);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (err) {
        s3WriteDurationHisto.record(Date.now() - start);
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        span.end();
        throw err;
      }
    });
  }
}

export function makeS3Client(opts: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}): S3Client {
  return new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: opts.forcePathStyle,
  });
}
