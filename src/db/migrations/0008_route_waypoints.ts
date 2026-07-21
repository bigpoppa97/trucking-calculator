import { Kysely } from 'kysely'

/**
 * Company-preferred route waypoints (PRD §3.3: preferred border crossings).
 * Keyed by route CODE (not FK) so waypoints can be defined before a route is
 * ever fetched from HERE. Sent as `via=lat,lon!passThrough=true` on fetch
 * and shape refresh, forcing HERE onto the corridor the trucks really drive.
 *
 * Seeded per dispatch request (2026-07-21): WAW-BUD runs via Chyżne (PL/SK)
 * and Šahy (SK/HU) on the E77 corridor.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('route_waypoints')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('route_code', 'text', col => col.notNull())
    .addColumn('seq', 'integer', col => col.notNull())
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('lat', 'numeric', col => col.notNull())
    .addColumn('lon', 'numeric', col => col.notNull())
    .addUniqueConstraint('route_waypoints_code_seq', ['route_code', 'seq'])
    .execute()

  await db
    .insertInto('route_waypoints')
    .values([
      { route_code: 'WAW-BUD', seq: 1, name: 'Chyżne (PL/SK)', lat: 49.4053, lon: 19.7204 },
      { route_code: 'WAW-BUD', seq: 2, name: 'Šahy (SK/HU)', lat: 48.0742, lon: 18.949 },
    ])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('route_waypoints').execute()
}
