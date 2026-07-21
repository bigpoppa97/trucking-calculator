import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_initial_schema.js'
import * as m0002 from './0002_toll_vehicle_profile.js'
import * as m0003 from './0003_km_override_audit.js'
import * as m0004 from './0004_users_and_sessions.js'
import * as m0005 from './0005_toll_system_rules.js'
import * as m0006 from './0006_route_polyline.js'
import * as m0007 from './0007_editable_month_days.js'
import * as m0008 from './0008_route_waypoints.js'

/**
 * In-code migration registry (instead of FileMigrationProvider) so migrations
 * run identically under tsx CLIs, vitest, and the compiled server — no
 * filesystem/loader coupling. Keys are ordered lexicographically by Kysely.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial_schema': m0001,
  '0002_toll_vehicle_profile': m0002,
  '0003_km_override_audit': m0003,
  '0004_users_and_sessions': m0004,
  '0005_toll_system_rules': m0005,
  '0006_route_polyline': m0006,
  '0007_editable_month_days': m0007,
  '0008_route_waypoints': m0008,
}
