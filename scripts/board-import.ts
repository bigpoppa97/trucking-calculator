import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../src/db/database.js'
import { BoardService } from '../src/board/boardService.js'
import { DistanceService } from '../src/board/distances.js'
import { ensurePlaceSeed } from '../src/board/placeSeed.js'
import { loadDotEnv } from '../src/loadDotEnv.js'

loadDotEnv()

/**
 * Import an export file from the command line (the same thing the
 * "Importuj eksport" button does):
 *
 *   npm run board:import -- ścieżka/eksport.xlsx [--history] [--now 2026-09-24T11:00:00Z]
 *
 * --history  older data: no "disappeared" checks, orders marked "sprzed tablicy"
 * --now      pretend the import happens at this moment (testing / back-filling)
 * Distances use straight-line estimates here; the running server replaces
 * them with HERE routes in the background.
 */

const file = process.argv[2]
if (!file || file.startsWith('--')) {
  console.error('Użycie: npm run board:import -- ścieżka/eksport.xlsx [--history] [--now ISO]')
  process.exit(1)
}
const nowIdx = process.argv.indexOf('--now')
const nowArg = nowIdx >= 0 ? process.argv[nowIdx + 1] : undefined

const databasePath = process.env['DATABASE_PATH'] ?? 'data/calculator.sqlite'
mkdirSync(dirname(databasePath), { recursive: true })
const db = createDatabase(databasePath)
try {
  await migrateToLatest(db)
  await ensurePlaceSeed(db)
  const service = new BoardService(db, new DistanceService({ db, allowHere: false }), {
    ...(nowArg ? { now: () => nowArg } : {}),
  })
  const summary = await service.importFile(readFileSync(file), basename(file), process.argv.includes('--history') ? 'history' : 'daily')
  console.log(`Plik: ${summary.filename} · ${summary.rowsTotal} wierszy · zakres ${summary.rangeFrom} – ${summary.rangeTo}`)
  console.log(`Twoja flota: ${summary.rowsInScope} · flota własna: ${summary.rowsOwnFleet} · inni przewoźnicy: ${summary.rowsOtherCarriers}`)
  console.log(`Nowe: ${summary.created.length} · zmienione: ${summary.updated.length} · bez zmian: ${summary.unchanged} · zniknęło: ${summary.disappeared.length}`)
  for (const w of summary.warnings) console.warn(`UWAGA: ${w}`)
  const open = await service.listIssues('open')
  console.log(`Do sprawdzenia: ${open.length}`)
  for (const i of open) console.log(`  [${i.kind}] ${i.ref}: ${i.message}`)
} finally {
  await db.destroy()
}
