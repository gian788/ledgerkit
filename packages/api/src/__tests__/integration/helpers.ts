import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import knex, { type Knex } from 'knex';
import { types as pgTypes } from 'pg';
import path from 'path';

// Mirror the BigInt type parser from shared/src/db.ts so test queries return
// BigInt for BIGINT columns, matching production behaviour.
pgTypes.setTypeParser(20, BigInt);

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../migrations');

export interface TestDb {
  db: Knex;
  container: StartedPostgreSqlContainer;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:16').start();

  const db = knex({
    client: 'pg',
    connection: container.getConnectionUri(),
  });

  await db.migrate.latest({
    directory: MIGRATIONS_DIR,
    loadExtensions: ['.ts'],
  });

  return { db, container };
}

export async function stopTestDb({ db, container }: TestDb): Promise<void> {
  await db.destroy();
  await container.stop();
}

/** Truncate all tables in FK-safe order between tests. */
export async function cleanDb(db: Knex): Promise<void> {
  await db.raw(
    'TRUNCATE outbox, journal_lines, journal_entries, transactions, wallets, users, organisations RESTART IDENTITY CASCADE',
  );
}
