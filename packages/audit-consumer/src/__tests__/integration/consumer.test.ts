import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { S3AuditStorage, makeS3Client } from '../../storage';
import { processAuditMessage } from '../../consumer';

const BUCKET = 'ledger-audit-test';

let container: StartedTestContainer;
let s3: S3Client;
let storage: S3AuditStorage;

beforeAll(async () => {
  container = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
    .withExposedPorts(9000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(9000);

  s3 = makeS3Client({
    endpoint: `http://${host}:${port}`,
    region: 'us-east-1',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    forcePathStyle: true,
  });

  storage = new S3AuditStorage(s3, BUCKET);
  await storage.ensureBucket();
}, 90_000);

afterAll(async () => {
  await container.stop();
});

it('writes an audit event to S3 and can read it back', async () => {
  await processAuditMessage(
    JSON.stringify({
      event: 'TRANSACTION_CREATED',
      resource_type: 'transaction',
      resource_id: 'tx-integration-1',
      after: { id: 'tx-integration-1', status: 'PENDING', amount: 5000 },
    }),
    storage,
  );

  // List objects in the bucket
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  expect(list.Contents?.length).toBeGreaterThanOrEqual(1);

  // Find the object we just wrote
  const key = list.Contents!.find((obj) => obj.Key?.includes('tx-integration-1'))?.Key;
  expect(key).toBeDefined();

  // Verify key format: YYYY/MM/DD/{resource_id}/{event}_{ts}_{uuid}.json
  expect(key).toMatch(
    /^\d{4}\/\d{2}\/\d{2}\/tx-integration-1\/TRANSACTION_CREATED_\d+_[0-9a-f-]+\.json$/,
  );

  // Read back and verify content
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key! }));
  const body = await obj.Body!.transformToString();
  const parsed = JSON.parse(body);

  expect(parsed).toMatchObject({
    event: 'TRANSACTION_CREATED',
    resource_type: 'transaction',
    resource_id: 'tx-integration-1',
    after: { status: 'PENDING', amount: 5000 },
  });
  expect(parsed.received_at).toBeTruthy();
});

it('writes TRANSACTION_CANCELLED with before+after preserved', async () => {
  await processAuditMessage(
    JSON.stringify({
      event: 'TRANSACTION_CANCELLED',
      resource_type: 'transaction',
      resource_id: 'tx-integration-2',
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
    }),
    storage,
  );

  // ListObjectsV2 doesn't search by resource_id in key path, fetch by prefix approach:
  const allList = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  const key = allList.Contents?.find((o) => o.Key?.includes('tx-integration-2'))?.Key;
  expect(key).toBeDefined();

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key! }));
  const parsed = JSON.parse(await obj.Body!.transformToString());

  expect(parsed.before).toEqual({ status: 'PENDING' });
  expect(parsed.after).toEqual({ status: 'CANCELLED' });
});

it('each event gets a unique S3 key (no overwrites)', async () => {
  const payload = JSON.stringify({
    event: 'TRANSACTION_CREATED',
    resource_type: 'transaction',
    resource_id: 'tx-integration-3',
    after: { status: 'PENDING' },
  });

  await processAuditMessage(payload, storage);
  await processAuditMessage(payload, storage);

  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  const keys = list.Contents?.filter((o) => o.Key?.includes('tx-integration-3')) ?? [];
  expect(keys).toHaveLength(2);
  expect(keys[0]!.Key).not.toBe(keys[1]!.Key);
});

it('ensureBucket is idempotent', async () => {
  await expect(storage.ensureBucket()).resolves.not.toThrow();
  await expect(storage.ensureBucket()).resolves.not.toThrow();
});
