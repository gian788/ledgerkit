function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  db: {
    url: optional('DATABASE_URL', 'postgresql://ledger:ledger@localhost:5432/ledger'),
    poolMin: Number(optional('DATABASE_POOL_MIN', '2')),
    poolMax: Number(optional('DATABASE_POOL_MAX', '10')),
  },
  kafka: {
    brokers: optional('KAFKA_BROKERS', 'localhost:9092').split(','),
    clientId: optional('KAFKA_CLIENT_ID', 'ledger'),
    topics: {
      transactions: optional('KAFKA_TOPIC_TRANSACTIONS', 'transactions.pending'),
      audit: optional('KAFKA_TOPIC_AUDIT', 'audit.events'),
    },
  },
  api: {
    port: Number(optional('PORT', '3000')),
    nodeEnv: optional('NODE_ENV', 'development'),
  },
  s3: {
    endpoint: optional('S3_ENDPOINT', 'http://localhost:9000'),
    region: optional('S3_REGION', 'us-east-1'),
    accessKeyId: optional('S3_ACCESS_KEY_ID', 'minioadmin'),
    secretAccessKey: optional('S3_SECRET_ACCESS_KEY', 'minioadmin'),
    auditBucket: optional('S3_AUDIT_BUCKET', 'ledger-audit'),
    forcePathStyle: optional('S3_FORCE_PATH_STYLE', 'true') === 'true',
  },
} as const;

export type Config = typeof config;
