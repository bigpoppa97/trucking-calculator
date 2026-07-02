import { Kysely, sql } from 'kysely'

/** Initial schema per PRD §5.2. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('airports')
    .addColumn('iata', 'text', col => col.primaryKey().check(sql`length(iata) = 3`))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('city', 'text', col => col.notNull())
    .addColumn('country', 'text', col => col.notNull())
    .addColumn('lat', 'real', col => col.notNull().check(sql`lat between -90 and 90`))
    .addColumn('lon', 'real', col => col.notNull().check(sql`lon between -180 and 180`))
    .execute()

  await db.schema
    .createTable('routes')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('route_code', 'text', col => col.notNull().unique())
    .addColumn('stops', 'text', col => col.notNull())
    .addColumn('total_km', 'real', col => col.notNull().check(sql`total_km > 0`))
    .addColumn('km_source', 'text', col => col.notNull().check(sql`km_source in ('here', 'manual')`))
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createTable('route_country_km')
    .addColumn('route_id', 'integer', col => col.notNull().references('routes.id').onDelete('cascade'))
    .addColumn('country', 'text', col => col.notNull().check(sql`length(country) = 2`))
    .addColumn('km', 'real', col => col.notNull().check(sql`km >= 0`))
    .addUniqueConstraint('uq_route_country_km', ['route_id', 'country'])
    .execute()

  await db.schema
    .createTable('route_country_toll')
    .addColumn('route_id', 'integer', col => col.notNull().references('routes.id').onDelete('cascade'))
    .addColumn('country', 'text', col => col.notNull().check(sql`length(country) = 2`))
    .addColumn('toll_eur', 'real', col => col.notNull().check(sql`toll_eur >= 0`))
    .addColumn('status', 'text', col => col.notNull().check(sql`status in ('estimate', 'verified')`))
    .addColumn('fetched_at', 'text')
    .addColumn('vehicle_profile', 'text')
    .addColumn('verified_by', 'text')
    .addColumn('verified_at', 'text')
    .addUniqueConstraint('uq_route_country_toll', ['route_id', 'country'])
    .execute()

  await db.schema
    .createTable('fleet_variants')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('name', 'text', col => col.notNull().unique())
    .addColumn('monthly_cost_eur', 'real', col => col.notNull().check(sql`monthly_cost_eur >= 0`))
    .addColumn('active', 'integer', col => col.notNull().defaultTo(1).check(sql`active in (0, 1)`))
    .execute()

  await db.schema
    .createTable('config')
    .addColumn('key', 'text', col => col.primaryKey())
    .addColumn('value', 'text', col => col.notNull())
    .execute()

  await db.schema
    .createTable('calculations')
    .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
    .addColumn('route_id', 'integer', col => col.notNull().references('routes.id'))
    .addColumn('days', 'real', col => col.notNull().check(sql`days >= 0.5`))
    .addColumn('drivers', 'integer', col => col.notNull().check(sql`drivers in (1, 2)`))
    .addColumn('fleet_variant_id', 'integer', col => col.notNull().references('fleet_variants.id'))
    .addColumn('ferries_eur', 'real', col => col.notNull().defaultTo(0).check(sql`ferries_eur >= 0`))
    .addColumn('tunnels_eur', 'real', col => col.notNull().defaultTo(0).check(sql`tunnels_eur >= 0`))
    .addColumn('revenue_eur', 'real', col => col.check(sql`revenue_eur is null or revenue_eur >= 0`))
    .addColumn('snapshot', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('created_at', 'text', col => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema.createIndex('ix_route_country_km_route').on('route_country_km').column('route_id').execute()
  await db.schema.createIndex('ix_route_country_toll_route').on('route_country_toll').column('route_id').execute()
  await db.schema.createIndex('ix_route_country_toll_status').on('route_country_toll').column('status').execute()
  await db.schema.createIndex('ix_calculations_route').on('calculations').column('route_id').execute()
  await db.schema.createIndex('ix_calculations_created_at').on('calculations').column('created_at').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('calculations').execute()
  await db.schema.dropTable('config').execute()
  await db.schema.dropTable('fleet_variants').execute()
  await db.schema.dropTable('route_country_toll').execute()
  await db.schema.dropTable('route_country_km').execute()
  await db.schema.dropTable('routes').execute()
  await db.schema.dropTable('airports').execute()
}
