import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TYPE journal_line_direction AS ENUM ('DEBIT', 'CREDIT')
  `);

  await knex.schema.createTable('journal_lines', (table) => {
    table.uuid('id').primary();
    table
      .uuid('journal_entry_id')
      .notNullable()
      .references('id')
      .inTable('journal_entries')
      .onDelete('RESTRICT');
    table.uuid('wallet_id').notNullable().references('id').inTable('wallets').onDelete('RESTRICT');
    table.bigInteger('amount').notNullable();
    table.specificType('direction', 'journal_line_direction').notNullable();

    table.check('amount > 0', [], 'journal_lines_amount_positive');

    table.index('journal_entry_id');
    table.index('wallet_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('journal_lines');
  await knex.raw('DROP TYPE journal_line_direction');
}
