import type { Kysely } from 'kysely'

/**
 * 28.10.2026 (paczka 28.10):
 *  - `board_notes.time`: optional hour ("HH:MM") of a day event on a truck (notes, pauses,
 *    position, trailer change).
 *  - `board_notes.auto_key`: a trailer change typed over an automatic one (the gray chip
 *    "WAW: AB1234P → AB5678P" edited on the board: other day, hour, place). The key names the
 *    automatic change (order, leg, old > new trailer) it replaces; when that change is no longer
 *    computed, the entry stays as a normal "Naczepa" event.
 *  - `board_notes.suppress`: 1 = "Usuń — nie było zmiany": the automatic change with that key
 *    is not shown (the entry itself is never shown either).
 *  - `board_driver_changes.time`: optional hour of a driver change — the driver of an order
 *    and the current driver follow it (before loading = the new driver, after unloading = the
 *    old one, in between = both).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('board_notes').addColumn('time', 'text').execute()
  await db.schema.alterTable('board_notes').addColumn('auto_key', 'text').execute()
  await db.schema
    .alterTable('board_notes')
    .addColumn('suppress', 'integer', col => col.notNull().defaultTo(0))
    .execute()
  await db.schema.alterTable('board_driver_changes').addColumn('time', 'text').execute()
  await db.schema.createIndex('ix_board_notes_auto_key').on('board_notes').columns(['truck_id', 'auto_key']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('ix_board_notes_auto_key').ifExists().execute()
  await db.schema.alterTable('board_driver_changes').dropColumn('time').execute()
  await db.schema.alterTable('board_notes').dropColumn('suppress').execute()
  await db.schema.alterTable('board_notes').dropColumn('auto_key').execute()
  await db.schema.alterTable('board_notes').dropColumn('time').execute()
}
