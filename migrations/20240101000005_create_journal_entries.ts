import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('journal_entries', (table) => {
    table.uuid('id').primary();
    table
      .uuid('transaction_id')
      .notNullable()
      .references('id')
      .inTable('transactions')
      .onDelete('RESTRICT');
    table.text('description').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // One journal entry per transaction (1:1 in the current model).
    table.unique(['transaction_id']);
    table.index('created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('journal_entries');
}
