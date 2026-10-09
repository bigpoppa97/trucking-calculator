import { Kysely, sql } from 'kysely'

/**
 * Kierowcy i certyfikaty (decisions of 08.10.2026).
 *
 * Drivers become their own list (name, phone, carrier). Which driver drives a
 * tractor comes from dated changes: the driver on a day = the latest change on
 * or before that day (driver_id NULL = no driver). One change per tractor and day.
 * Certificates (AVSEC first) belong to the driver; scans live on disk next to
 * the database (data/pliki), never in the database or the repository.
 *
 * The current driver and phone of every tractor become the first drivers,
 * valid "from the beginning" (day 2000-01-01). The old columns on board_trucks
 * are left as they were (no longer read).
 */
export const FROM_THE_BEGINNING = '2000-01-01'

export async function up(outer: Kysely<any>): Promise<void> {
  // SQLite migrations are not transactional in Kysely: wrap everything, so a failure leaves no half-made tables.
  await outer.transaction().execute(async db => {
    await db.schema
      .createTable('board_drivers')
      .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('phone', 'text', col => col.notNull().defaultTo(''))
      .addColumn('carrier', 'text', col => col.notNull().defaultTo(''))
      .addColumn('notes', 'text', col => col.notNull().defaultTo(''))
      .addColumn('active', 'integer', col => col.notNull().defaultTo(1).check(sql`active in (0, 1)`))
      .addColumn('created_at', 'text', col => col.notNull())
      .execute()

    await db.schema
      .createTable('board_driver_changes')
      .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
      .addColumn('truck_id', 'integer', col => col.notNull().references('board_trucks.id').onDelete('cascade'))
      .addColumn('driver_id', 'integer', col => col.references('board_drivers.id').onDelete('set null'))
      .addColumn('day', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('created_at', 'text', col => col.notNull())
      .addUniqueConstraint('uq_board_driver_changes', ['truck_id', 'day'])
      .execute()

    await db.schema
      .createTable('board_driver_certs')
      .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
      .addColumn('driver_id', 'integer', col => col.notNull().references('board_drivers.id').onDelete('cascade'))
      .addColumn('kind', 'text', col => col.notNull())
      .addColumn('number', 'text', col => col.notNull().defaultTo(''))
      .addColumn('valid_to', 'text')
      .addColumn('notes', 'text', col => col.notNull().defaultTo(''))
      .addColumn('deleted', 'integer', col => col.notNull().defaultTo(0).check(sql`deleted in (0, 1)`))
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('created_at', 'text', col => col.notNull())
      .addColumn('updated_by', 'text', col => col.notNull())
      .addColumn('updated_at', 'text', col => col.notNull())
      .execute()

    await db.schema
      .createTable('board_driver_cert_files')
      .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
      .addColumn('cert_id', 'integer', col => col.notNull().references('board_driver_certs.id').onDelete('cascade'))
      .addColumn('filename', 'text', col => col.notNull())
      .addColumn('stored_name', 'text', col => col.notNull().unique())
      .addColumn('mime', 'text', col => col.notNull())
      .addColumn('size', 'integer', col => col.notNull())
      .addColumn('uploaded_by', 'text', col => col.notNull())
      .addColumn('uploaded_at', 'text', col => col.notNull())
      .execute()

    await db.schema.createIndex('ix_board_driver_changes_truck').on('board_driver_changes').columns(['truck_id', 'day']).execute()
    await db.schema.createIndex('ix_board_driver_changes_driver').on('board_driver_changes').column('driver_id').execute()
    await db.schema.createIndex('ix_board_driver_certs_driver').on('board_driver_certs').column('driver_id').execute()
    await db.schema.createIndex('ix_board_driver_cert_files_cert').on('board_driver_cert_files').column('cert_id').execute()

    // Current drivers of the tractors → the driver list, valid from the beginning.
    const now = new Date().toISOString()
    const trucks = (await db.selectFrom('board_trucks').select(['id', 'driver', 'phone', 'carrier']).orderBy('sort_order').orderBy('id').execute()) as Array<{
      id: number
      driver: string
      phone: string
      carrier: string
    }>
    const known = new Map<string, number>()
    for (const t of trucks) {
      const name = t.driver.trim().replace(/\s+/g, ' ')
      if (!name) continue
      const key = `${name.toLowerCase()}|${t.carrier.trim().toLowerCase()}`
      let driverId = known.get(key)
      if (driverId === undefined) {
        const row = (await db
          .insertInto('board_drivers')
          .values({ name, phone: t.phone.trim(), carrier: t.carrier.trim(), created_at: now })
          .returning('id')
          .executeTakeFirstOrThrow()) as { id: number }
        driverId = row.id
        known.set(key, driverId)
      }
      await db
        .insertInto('board_driver_changes')
        .values({ truck_id: t.id, driver_id: driverId, day: FROM_THE_BEGINNING, created_by: 'migracja', created_at: now })
        .execute()
    }
  })
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('board_driver_cert_files').ifExists().execute()
  await db.schema.dropTable('board_driver_certs').ifExists().execute()
  await db.schema.dropTable('board_driver_changes').ifExists().execute()
  await db.schema.dropTable('board_drivers').ifExists().execute()
}
