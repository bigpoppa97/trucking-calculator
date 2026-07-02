import { Kysely } from 'kysely'

/**
 * Seed the SINGLE global toll vehicle profile (PRD §4.3, CONFIRMED business
 * input): the entire fleet is uniform — 5-axle tractor-trailer, 40 t GVW,
 * Euro 6. One config entry, never a per-fleet-variant attribute.
 */
export const DEFAULT_TOLL_VEHICLE_PROFILE = {
  axleCount: 5,
  grossWeightKg: 40000,
  emissionType: 'euro6',
}

export async function up(db: Kysely<any>): Promise<void> {
  await db
    .insertInto('config')
    .values({ key: 'toll_vehicle_profile', value: JSON.stringify(DEFAULT_TOLL_VEHICLE_PROFILE) })
    .onConflict((oc: any) => oc.column('key').doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('config').where('key', '=', 'toll_vehicle_profile').execute()
}
