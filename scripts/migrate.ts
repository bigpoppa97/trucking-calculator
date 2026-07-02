import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../src/db/database.js'

const databasePath = process.env['DATABASE_PATH'] ?? 'data/calculator.sqlite'
mkdirSync(dirname(databasePath), { recursive: true })

const db = createDatabase(databasePath)
try {
  const applied = await migrateToLatest(db)
  console.log(applied.length === 0 ? 'Database already up to date.' : `Applied migrations: ${applied.join(', ')}`)
  console.log(`Database: ${databasePath}`)
} finally {
  await db.destroy()
}
