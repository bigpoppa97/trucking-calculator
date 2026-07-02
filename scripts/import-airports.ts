import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../src/db/database.js'
import { importAirports } from '../src/import/importAirports.js'

const csvPath = process.argv[2]
if (!csvPath) {
  console.error('Usage: npm run import:airports -- path/to/airports.csv')
  console.error('Expected CSV header: iata,name,city,country,lat,lon')
  process.exit(1)
}

const databasePath = process.env['DATABASE_PATH'] ?? 'data/calculator.sqlite'
mkdirSync(dirname(databasePath), { recursive: true })
const db = createDatabase(databasePath)
try {
  await migrateToLatest(db)
  const report = await importAirports(db, readFileSync(csvPath, 'utf-8'))
  console.log(`Airports imported/updated: ${report.imported}`)
  for (const warning of report.warnings) console.warn(`WARN: ${warning}`)
} finally {
  await db.destroy()
}
