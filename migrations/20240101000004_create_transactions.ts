import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TYPE transaction_status AS ENUM ('PENDING', 'SETTLED', 'FAILED', 'CANCELLED')
  `);

  await knex.schema.createTable('transactions', (table) => {
    table.uuid('id').primary();
    table.string('idempotency_key').notNullable().unique();
    table.uuid('source_wallet_id').notNullable().references('id').inTable('wallets').onDelete('RESTRICT');
    table.uuid('destination_wallet_id').notNullable().references('id').inTable('wallets').onDelete('RESTRICT');
    table.bigInteger('amount').notNullable();
    table.specificType('currency', 'CHAR(3)').notNullable();
    table.specificType('status', 'transaction_status').notNullable().defaultTo('PENDING');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('settled_at', { useTz: true }).nullable();

    table.check('amount > 0', [], 'transactions_amount_positive');

    table.index('source_wallet_id');
    table.index('destination_wallet_id');
    table.index('status');
    table.index('created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('transactions');
  await knex.raw('DROP TYPE transaction_status');
}
