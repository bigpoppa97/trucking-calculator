import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../src/db/database.js'
import { importV1 } from '../src/import/importV1.js'

const databasePath = process.env['DATABASE_PATH'] ?? 'data/calculator.sqlite'
const trasyPath = process.argv[2] ?? 'data/v1/Trasy.csv'
const konfiguracjaPath = process.argv[3] ?? 'data/v1/Konfiguracja.csv'

mkdirSync(dirname(databasePath), { recursive: true })
const db = createDatabase(databasePath)
try {
  await migrateToLatest(db)
  const report = await importV1(db, {
    trasyCsv: readFileSync(trasyPath, 'utf-8'),
    konfiguracjaCsv: readFileSync(konfiguracjaPath, 'utf-8'),
  })

  console.log(`Config keys applied:   ${report.configKeysApplied.join(', ')}`)
  console.log(`Fleet variants:        ${report.variantsUpserted.join(', ')}`)
  console.log(`Routes inserted:       ${report.routesInserted.length} (${report.routesInserted.join(', ')})`)
  if (report.routesSkippedExisting.length > 0) {
    console.log(`Routes skipped:        ${report.routesSkippedExisting.length} already present (${report.routesSkippedExisting.join(', ')})`)
  }
  console.log(`Tolls imported:        ${report.tollsImportedVerified} verified`)
  console.log(`Tolls left pending:    ${report.tollsLeftPending} (countries driven but no sheet toll value)`)
  for (const warning of report.warnings) console.warn(`WARN: ${warning}`)
} finally {
  await db.destroy()
}
