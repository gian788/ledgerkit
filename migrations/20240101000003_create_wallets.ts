import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('wallets', (table) => {
    table.uuid('id').primary();
    table
      .uuid('organisation_id')
      .notNullable()
      .references('id')
      .inTable('organisations')
      .onDelete('RESTRICT');
    table.specificType('currency', 'CHAR(3)').notNullable();
    table.bigInteger('balance').notNullable().defaultTo(0);
    table.bigInteger('pending_amount').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Updated by the settlement worker on every balance change; used by the balance endpoint.
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index('organisation_id');

    // Balance invariant: available funds = balance - pending_amount >= 0.
    // Enforced here as a belt-and-suspenders guard; the real enforcement is the
    // atomic conditional UPDATE (DD-5).
    table.check('balance >= 0', [], 'wallets_balance_non_negative');
    table.check('pending_amount >= 0', [], 'wallets_pending_amount_non_negative');
    table.check('balance >= pending_amount', [], 'wallets_available_non_negative');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('wallets');
}
