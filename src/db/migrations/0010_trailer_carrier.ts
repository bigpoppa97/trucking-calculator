import type { Kysely } from 'kysely'

/**
 * Trailers belong to a carrier (subcontractor), not to a tractor: carriers
 * with several sets rotate their trailers between their tractors.
 * `active_to` = last day the trailer was in the fleet (NULL = still in it);
 * orders loaded after that day with this trailer go to the review queue.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('board_trailers')
    .addColumn('carrier', 'text', col => col.notNull().defaultTo(''))
    .execute()
  await db.schema.alterTable('board_trailers').addColumn('active_to', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('board_trailers').dropColumn('active_to').execute()
  await db.schema.alterTable('board_trailers').dropColumn('carrier').execute()
}
