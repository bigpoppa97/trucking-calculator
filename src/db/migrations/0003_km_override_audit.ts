import { Kysely } from 'kysely'

/**
 * Audit fields for manual km overrides (PRD §5.3: "manual km override with
 * audit note"): who changed the distances, when, and why (e.g. "jeździmy
 * przez Kudowę-Zdrój, HERE prowadzi przez Zgorzelec").
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('routes').addColumn('km_note', 'text').execute()
  await db.schema.alterTable('routes').addColumn('km_updated_by', 'text').execute()
  await db.schema.alterTable('routes').addColumn('km_updated_at', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('routes').dropColumn('km_updated_at').execute()
  await db.schema.alterTable('routes').dropColumn('km_updated_by').execute()
  await db.schema.alterTable('routes').dropColumn('km_note').execute()
}
