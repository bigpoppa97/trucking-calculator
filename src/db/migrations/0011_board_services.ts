import { Kysely, sql } from 'kysely'

/**
 * Serwis — periods when a fleet set is unavailable (decisions of 08.10.2026).
 *
 * A service concerns the tractor or a trailer (by plate; trailers rotate between
 * a carrier's tractors, so a trailer service follows the trailer). `status`:
 *  - required:  the carrier reported a need ("oil change") without a date;
 *  - planned:   dates set — all day(s) or with hours (start/end wall time, Poland);
 *  - cancelled: did not happen, kept in the history;
 *  - deleted:   entered by mistake, hidden (kept for the change log).
 * "Done" is derived from the end time. Services never change km or money.
 *
 * Old board events of kind 'service' (single day, free text) become all-day
 * planned services and are removed from the event list.
 */
export async function up(outer: Kysely<any>): Promise<void> {
  // SQLite migrations are not transactional in Kysely: wrap everything, so a failure leaves no half-made tables.
  await outer.transaction().execute(async db => {
    await db.schema
      .createTable('board_services')
      .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
      .addColumn('truck_id', 'integer', col => col.references('board_trucks.id').onDelete('cascade'))
      .addColumn('target', 'text', col => col.notNull().check(sql`target in ('truck', 'trailer')`))
      .addColumn('trailer_plate', 'text')
      .addColumn('status', 'text', col => col.notNull().check(sql`status in ('required', 'planned', 'cancelled', 'deleted')`))
      .addColumn('all_day', 'integer', col => col.notNull().defaultTo(0).check(sql`all_day in (0, 1)`))
      .addColumn('start_day', 'text')
      .addColumn('start_time', 'text')
      .addColumn('end_day', 'text')
      .addColumn('end_time', 'text')
      .addColumn('description', 'text', col => col.notNull().defaultTo(''))
      .addColumn('place', 'text', col => col.notNull().defaultTo(''))
      .addColumn('reported_at', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('created_at', 'text', col => col.notNull())
      .addColumn('updated_by', 'text', col => col.notNull())
      .addColumn('updated_at', 'text', col => col.notNull())
      .execute()

    await db.schema
      .createTable('board_service_changes')
      .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
      .addColumn('service_id', 'integer', col => col.notNull().references('board_services.id').onDelete('cascade'))
      .addColumn('text', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('created_at', 'text', col => col.notNull())
      .execute()

    await db.schema.createIndex('ix_board_services_truck').on('board_services').column('truck_id').execute()
    await db.schema.createIndex('ix_board_services_trailer').on('board_services').column('trailer_plate').execute()
    await db.schema.createIndex('ix_board_services_days').on('board_services').columns(['start_day', 'end_day']).execute()
    await db.schema.createIndex('ix_board_service_changes_service').on('board_service_changes').column('service_id').execute()

    // Old single-day "Serwis" events → all-day planned services.
    const old = await db
      .selectFrom('board_notes')
      .leftJoin('board_places', 'board_places.code', 'board_notes.place_code')
      .select([
        'board_notes.id as id',
        'board_notes.truck_id as truck_id',
        'board_notes.day as day',
        'board_notes.text as text',
        'board_notes.created_by as created_by',
        'board_notes.created_at as created_at',
        'board_places.name as place_name',
      ])
      .where('board_notes.kind', '=', 'service')
      .where('board_notes.scope', '=', 'truck_day')
      .where('board_notes.deleted', '=', 0)
      .execute()
    for (const n of old as Array<{ id: number; truck_id: number | null; day: string | null; text: string; created_by: string; created_at: string; place_name: string | null }>) {
      if (n.truck_id === null || n.day === null) continue
      const inserted = await db
        .insertInto('board_services')
        .values({
          truck_id: n.truck_id,
          target: 'truck',
          trailer_plate: null,
          status: 'planned',
          all_day: 1,
          start_day: n.day,
          end_day: n.day,
          description: n.text === 'Serwis' ? '' : n.text,
          place: n.place_name ?? '',
          reported_at: n.created_at,
          created_by: n.created_by,
          created_at: n.created_at,
          updated_by: n.created_by,
          updated_at: n.created_at,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('board_service_changes')
        .values({
          service_id: (inserted as { id: number }).id,
          text: 'Przeniesione ze zdarzenia „Serwis” na tablicy (cały dzień).',
          created_by: n.created_by,
          created_at: n.created_at,
        })
        .execute()
      await db.updateTable('board_notes').set({ deleted: 1 }).where('id', '=', n.id).execute()
    }
  })
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('board_service_changes').ifExists().execute()
  await db.schema.dropTable('board_services').ifExists().execute()
}
