import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TYPE outbox_event_type AS ENUM ('SETTLEMENT', 'AUDIT')
  `);

  await knex.schema.createTable('outbox', (table) => {
    table.uuid('id').primary();
    table.specificType('type', 'outbox_event_type').notNullable();
    table.uuid('transaction_id').notNullable().references('id').inTable('transactions').onDelete('RESTRICT');
    table.jsonb('payload').notNullable();
    table.boolean('published').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('published_at', { useTz: true }).nullable();

    // Primary query pattern: unpublished rows ordered by creation time.
    table.index(['published', 'created_at']);
    table.index('transaction_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('outbox');
  await knex.raw('DROP TYPE outbox_event_type');
}
