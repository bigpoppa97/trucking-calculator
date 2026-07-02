import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createTestDatabase, migrateToLatest } from './database.js'

describe('migrations', () => {
  it('migrates an empty database to the latest schema', async () => {
    const db = createTestDatabase()
    try {
      const applied = await migrateToLatest(db)
      expect(applied).toContain('0001_initial_schema')

      const tables = await sql<{ name: string }>`
        select name from sqlite_master where type = 'table' order by name
      `.execute(db)
      const names = tables.rows.map(r => r.name)
      for (const expected of [
        'airports',
        'routes',
        'route_country_km',
        'route_country_toll',
        'fleet_variants',
        'config',
        'calculations',
      ]) {
        expect(names).toContain(expected)
      }
    } finally {
      await db.destroy()
    }
  })

  it('is a no-op when already migrated', async () => {
    const db = createTestDatabase()
    try {
      await migrateToLatest(db)
      const applied = await migrateToLatest(db)
      expect(applied).toEqual([])
    } finally {
      await db.destroy()
    }
  })

  it('enforces enum-style CHECK constraints', async () => {
    const db = createTestDatabase()
    try {
      await migrateToLatest(db)
      await expect(
        db
          .insertInto('routes')
          .values({
            route_code: 'WAW-PRG',
            stops: '["WAW","PRG"]',
            total_km: 680,
            km_source: 'guessed' as never,
            created_by: 'test',
          })
          .execute(),
      ).rejects.toThrow(/CHECK/i)
    } finally {
      await db.destroy()
    }
  })
})
