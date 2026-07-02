import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_initial_schema.js'

/**
 * In-code migration registry (instead of FileMigrationProvider) so migrations
 * run identically under tsx CLIs, vitest, and the compiled server — no
 * filesystem/loader coupling. Keys are ordered lexicographically by Kysely.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial_schema': m0001,
}
