import { Kysely } from 'kysely'

/**
 * Encoded route shape for the map preview. Stores a JSON array of HERE
 * sections — [{ polyline: <flexible-polyline string>, spans: [{offset,
 * country}] }] — because multi-stop routes return one polyline per section
 * and the span offsets enable per-country color coding. NULL for routes
 * imported from v1 (map shows the straight-line fallback).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('routes').addColumn('polyline_encoded', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('routes').dropColumn('polyline_encoded').execute()
}
