import type { Knex } from 'knex';
import * as path from 'path';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'] ?? 'postgresql://ledger:ledger@localhost:5432/ledger',
  pool: {
    min: Number(process.env['DATABASE_POOL_MIN'] ?? 2),
    max: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
  },
  migrations: {
    directory: path.resolve(__dirname, '../../migrations'),
    extension: 'ts',
    loadExtensions: ['.ts'],
  },
};

export default config;
