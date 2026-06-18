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
} as const;

export type Config = typeof config;
