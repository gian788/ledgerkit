import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('organisations', (table) => {
    table.uuid('id').primary();
    table.string('name').notNullable();
    table.string('jurisdiction').notNullable();
    table.string('residency').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('organisations');
}
