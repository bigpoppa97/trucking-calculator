import { Kysely, sql } from 'kysely'

/**
 * Tablica floty (fleet board) — the subcontractor-fleet module.
 *
 * Source of truth for orders is the company application's grid export
 * (xlsx). The board stores the imported orders plus everything the app does
 * not know: the fleet registry (trucks with plate history, trailers with
 * spelling variants), the place dictionary used for km, pairwise distances,
 * board-only notes/events, manual corrections and the review queue.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('board_trucks')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('carrier', 'text', col => col.notNull().defaultTo(''))
    .addColumn('driver', 'text', col => col.notNull().defaultTo(''))
    .addColumn('phone', 'text', col => col.notNull().defaultTo(''))
    .addColumn('trailer_plate', 'text')
    .addColumn('notes', 'text', col => col.notNull().defaultTo(''))
    .addColumn('active', 'integer', col => col.notNull().defaultTo(1).check(sql`active in (0, 1)`))
    .addColumn('sort_order', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createTable('board_truck_plates')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('truck_id', 'integer', col => col.notNull().references('board_trucks.id').onDelete('cascade'))
    .addColumn('plate', 'text', col => col.notNull())
    .addColumn('valid_from', 'text', col => col.notNull())
    .addColumn('valid_to', 'text')
    .addUniqueConstraint('uq_board_truck_plates', ['plate', 'valid_from'])
    .execute()

  await db.schema
    .createTable('board_trailers')
    .addColumn('plate', 'text', col => col.primaryKey())
    .addColumn('type_pl', 'text', col => col.notNull().defaultTo('chłodnia 2,61 m · rolki'))
    .addColumn('type_en', 'text', col => col.notNull().defaultTo('cooler 2.61m rollerbed'))
    .addColumn('notes', 'text', col => col.notNull().defaultTo(''))
    .execute()

  await db.schema
    .createTable('board_trailer_aliases')
    .addColumn('alias', 'text', col => col.primaryKey())
    .addColumn('trailer_plate', 'text', col => col.notNull().references('board_trailers.plate').onDelete('cascade'))
    .execute()

  await db.schema
    .createTable('board_places')
    .addColumn('code', 'text', col => col.primaryKey())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('country', 'text', col => col.notNull().defaultTo(''))
    .addColumn('lat', 'real', col => col.notNull().check(sql`lat between -90 and 90`))
    .addColumn('lon', 'real', col => col.notNull().check(sql`lon between -180 and 180`))
    .addColumn('kind', 'text', col => col.notNull().check(sql`kind in ('airport', 'custom')`))
    .execute()

  await db.schema
    .createTable('board_place_aliases')
    .addColumn('alias', 'text', col => col.primaryKey())
    .addColumn('place_code', 'text', col => col.notNull().references('board_places.code').onDelete('cascade'))
    .execute()

  await db.schema
    .createTable('board_distances')
    .addColumn('from_code', 'text', col => col.notNull())
    .addColumn('to_code', 'text', col => col.notNull())
    .addColumn('km', 'real', col => col.notNull().check(sql`km >= 0`))
    .addColumn('source', 'text', col =>
      col.notNull().check(sql`source in ('here', 'manual', 'estimate', 'calculator')`),
    )
    .addColumn('note', 'text')
    .addColumn('updated_at', 'text', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint('pk_board_distances', ['from_code', 'to_code'])
    .execute()

  await db.schema
    .createTable('board_own_plates')
    .addColumn('plate', 'text', col => col.primaryKey())
    .addColumn('last_seen', 'text', col => col.notNull())
    .execute()

  await db.schema
    .createTable('board_ignored_plates')
    .addColumn('plate', 'text', col => col.primaryKey())
    .addColumn('reason', 'text', col => col.notNull().defaultTo(''))
    .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createTable('board_imports')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('filename', 'text', col => col.notNull())
    .addColumn('imported_at', 'text', col => col.notNull())
    .addColumn('mode', 'text', col => col.notNull().check(sql`mode in ('daily', 'history')`))
    .addColumn('rows_total', 'integer', col => col.notNull())
    .addColumn('rows_in_scope', 'integer', col => col.notNull())
    .addColumn('range_from', 'text')
    .addColumn('range_to', 'text')
    .addColumn('summary', 'text', col => col.notNull())
    .execute()

  await db.schema
    .createTable('board_orders')
    .addColumn('order_no', 'text', col => col.primaryKey())
    .addColumn('client', 'text', col => col.notNull().defaultTo(''))
    .addColumn('client_ref', 'text', col => col.notNull().defaultTo(''))
    .addColumn('status_client', 'text', col => col.notNull().defaultTo(''))
    .addColumn('status_sped', 'text', col => col.notNull().defaultTo(''))
    .addColumn('carrier', 'text', col => col.notNull().defaultTo(''))
    .addColumn('sub_plate', 'text', col => col.notNull().defaultTo(''))
    .addColumn('own_plate', 'text', col => col.notNull().defaultTo(''))
    .addColumn('trailer_raw', 'text', col => col.notNull().defaultTo(''))
    .addColumn('load_places', 'text', col => col.notNull().defaultTo(''))
    .addColumn('load_country', 'text', col => col.notNull().defaultTo(''))
    .addColumn('load_date', 'text', col => col.notNull())
    .addColumn('unload_places', 'text', col => col.notNull().defaultTo(''))
    .addColumn('unload_country', 'text', col => col.notNull().defaultTo(''))
    .addColumn('unload_date', 'text', col => col.notNull())
    .addColumn('rev_eur', 'real')
    .addColumn('cost_eur', 'real')
    .addColumn('notes_app', 'text', col => col.notNull().defaultTo(''))
    .addColumn('history', 'integer', col => col.notNull().defaultTo(0).check(sql`history in (0, 1)`))
    .addColumn('first_import_id', 'integer', col => col.notNull())
    .addColumn('last_import_id', 'integer', col => col.notNull())
    .addColumn('missing_since_import_id', 'integer')
    .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'text', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createTable('board_order_changes')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('order_no', 'text', col => col.notNull().references('board_orders.order_no').onDelete('cascade'))
    .addColumn('import_id', 'integer')
    .addColumn('field', 'text', col => col.notNull())
    .addColumn('old_value', 'text')
    .addColumn('new_value', 'text')
    .addColumn('created_at', 'text', col => col.notNull())
    .execute()

  await db.schema
    .createTable('board_overrides')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('order_no', 'text', col => col.notNull().references('board_orders.order_no').onDelete('cascade'))
    .addColumn('field', 'text', col => col.notNull())
    .addColumn('value', 'text', col => col.notNull())
    .addColumn('app_value', 'text')
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('active', 'integer', col => col.notNull().defaultTo(1).check(sql`active in (0, 1)`))
    .addColumn('superseded_at', 'text')
    .addColumn('superseded_note', 'text')
    .execute()

  await db.schema
    .createTable('board_notes')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('scope', 'text', col => col.notNull().check(sql`scope in ('order', 'truck_day', 'truck')`))
    .addColumn('order_no', 'text')
    .addColumn('truck_id', 'integer', col => col.references('board_trucks.id').onDelete('cascade'))
    .addColumn('day', 'text')
    .addColumn('kind', 'text', col =>
      col.notNull().check(sql`kind in ('note', 'pause', 'service', 'driver', 'trailer', 'position')`),
    )
    .addColumn('text', 'text', col => col.notNull())
    .addColumn('place_code', 'text')
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted', 'integer', col => col.notNull().defaultTo(0).check(sql`deleted in (0, 1)`))
    .execute()

  await db.schema
    .createTable('board_issues')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('key', 'text', col => col.notNull().unique())
    .addColumn('kind', 'text', col => col.notNull())
    .addColumn('ref', 'text', col => col.notNull())
    .addColumn('message', 'text', col => col.notNull())
    .addColumn('details', 'text', col => col.notNull().defaultTo('{}'))
    .addColumn('fingerprint', 'text', col => col.notNull().defaultTo(''))
    .addColumn('status', 'text', col => col.notNull().check(sql`status in ('open', 'resolved', 'ignored')`))
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('updated_at', 'text', col => col.notNull())
    .addColumn('resolved_by', 'text')
    .addColumn('resolution', 'text')
    .execute()

  await db.schema.createIndex('ix_board_truck_plates_plate').on('board_truck_plates').column('plate').execute()
  await db.schema.createIndex('ix_board_orders_load').on('board_orders').column('load_date').execute()
  await db.schema.createIndex('ix_board_orders_unload').on('board_orders').column('unload_date').execute()
  await db.schema.createIndex('ix_board_order_changes_order').on('board_order_changes').column('order_no').execute()
  await db.schema.createIndex('ix_board_overrides_order').on('board_overrides').column('order_no').execute()
  await db.schema.createIndex('ix_board_notes_order').on('board_notes').column('order_no').execute()
  await db.schema.createIndex('ix_board_notes_truck_day').on('board_notes').columns(['truck_id', 'day']).execute()
  await db.schema.createIndex('ix_board_issues_status').on('board_issues').column('status').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'board_issues',
    'board_notes',
    'board_overrides',
    'board_order_changes',
    'board_orders',
    'board_imports',
    'board_ignored_plates',
    'board_own_plates',
    'board_distances',
    'board_place_aliases',
    'board_places',
    'board_trailer_aliases',
    'board_trailers',
    'board_truck_plates',
    'board_trucks',
  ]) {
    await db.schema.dropTable(table).ifExists().execute()
  }
}
