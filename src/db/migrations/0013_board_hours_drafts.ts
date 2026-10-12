import type { Kysely } from 'kysely'

/**
 * 12.10.2026 (paczka QoL):
 *  - Hours of loading and unloading from the export ("Godziny załadunku",
 *    "Godziny rozładunku"): `load_time` / `unload_time`, wall time "HH:MM" in
 *    Poland, NULL = not given. Used to put two orders sharing a day in one row.
 *  - Preliminary orders (zlecenia wstępne) typed on the board before the client
 *    order exists in the application: `draft` = 1, `draft_truck_id` = the fleet
 *    truck they were entered for. Numbers "W-1", "W-2"… (config key
 *    board_draft_seq). An imported order replaces its draft.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('board_orders').addColumn('load_time', 'text').execute()
  await db.schema.alterTable('board_orders').addColumn('unload_time', 'text').execute()
  await db.schema
    .alterTable('board_orders')
    .addColumn('draft', 'integer', col => col.notNull().defaultTo(0))
    .execute()
  await db.schema
    .alterTable('board_orders')
    .addColumn('draft_truck_id', 'integer', col => col.references('board_trucks.id').onDelete('set null'))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('board_orders').where('draft', '=', 1).execute()
  await db.schema.alterTable('board_orders').dropColumn('draft_truck_id').execute()
  await db.schema.alterTable('board_orders').dropColumn('draft').execute()
  await db.schema.alterTable('board_orders').dropColumn('unload_time').execute()
  await db.schema.alterTable('board_orders').dropColumn('load_time').execute()
}
