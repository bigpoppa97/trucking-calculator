import { Kysely } from 'kysely'

/**
 * month_days becomes finance-editable with default 24 (2026-07 business
 * sign-off, overriding the original PRD §2.1 fixed-30 decision). Fleet and
 * overhead components divide by this value, so new calculations change;
 * saved calculation snapshots are frozen and unaffected.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db
    .insertInto('config')
    .values({ key: 'month_days', value: '24' })
    .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: '24' }))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.updateTable('config').set({ value: '30' }).where('key', '=', 'month_days').execute()
}
