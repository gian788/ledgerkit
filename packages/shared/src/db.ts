import knex, { type Knex } from 'knex';
import { types as pgTypes } from 'pg';
import { config } from './config.js';

// Return BIGINT (OID 20) columns as JavaScript BigInt instead of string.
// BigInt is not JSON-serializable — callers must convert via .toString() before
// sending over the wire (handled in the API's JSON replacer).
pgTypes.setTypeParser(20, BigInt);

let _db: Knex | null = null;

export function getDb(): Knex {
  if (!_db) {
    _db = knex({
      client: 'pg',
      connection: config.db.url,
      pool: {
        min: config.db.poolMin,
        max: config.db.poolMax,
      },
    });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
}
