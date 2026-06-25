import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';

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
