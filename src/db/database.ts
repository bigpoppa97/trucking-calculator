import SqliteDatabase from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { DB } from './schema.js'
import { migrations } from './migrations/index.js'

/**
 * Database factory. SQLite for now (PRD §5.1 — acceptable for MVP);
 * the Postgres swap later means providing a PostgresDialect here — all
 * queries go through Kysely and the repository layer, so they don't change.
 */
export function createDatabase(filename: string): Kysely<DB> {
  const sqlite = new SqliteDatabase(filename)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON') // off by default in SQLite — required for our FKs
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
}

/** In-memory database for tests. */
export function createTestDatabase(): Kysely<DB> {
  return createDatabase(':memory:')
}

/** Run all pending migrations. Throws on the first failed migration. */
export async function migrateToLatest(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  })
  const { error, results } = await migrator.migrateToLatest()
  if (error) throw error instanceof Error ? error : new Error(String(error))
  return (results ?? []).filter(r => r.status === 'Success').map(r => r.migrationName)
}
