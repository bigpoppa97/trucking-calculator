import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../src/db/database.js'
import { BoardService } from '../src/board/boardService.js'
import { DistanceService } from '../src/board/distances.js'
import { grafikWeekTotals, readGrafik } from '../src/board/grafik.js'
import { addDays, weekStart } from '../src/board/normalize.js'
import { loadDotEnv } from '../src/loadDotEnv.js'

loadDotEnv()

/**
 * Parallel-run check (stage 2): compares the board with the Excel planner
 * week by week and truck by truck.
 *
 *   npm run board:compare -- --grafik ścieżka/grafik.xlsm --from 2026-09-07 [--to 2026-09-27]
 *
 * Differences are expected where the planner was filled differently
 * (skonto, trailer swaps without a PRZ entry, PLN amounts, late corrections);
 * every difference should have an explanation before the planner is retired.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const grafikPath = arg('grafik')
const from = arg('from')
if (!grafikPath || !from) {
  console.error('Użycie: npm run board:compare -- --grafik grafik.xlsm --from RRRR-MM-DD [--to RRRR-MM-DD]')
  process.exit(1)
}
const to = arg('to') ?? addDays(weekStart(from), 6)

const eur = (n: number) => `${Math.round(n).toLocaleString('pl-PL').replace(/ /g, ' ')}`.padStart(8)
const databasePath = process.env['DATABASE_PATH'] ?? 'data/calculator.sqlite'
mkdirSync(dirname(databasePath), { recursive: true })
const db = createDatabase(databasePath)
try {
  await migrateToLatest(db)
  const service = new BoardService(db, new DistanceService({ db, allowHere: false }))
  const weeks = await readGrafik(grafikPath)
  for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) {
    const view = await service.weekView(ws)
    const g = weeks.find(w => w.weekStart === ws)
    console.log(`\n=== Tydzień ${view.weekNumber} (${ws}) ===`)
    if (!g) {
      console.log('  (brak arkusza w grafiku)')
      continue
    }
    const gt = grafikWeekTotals(g)
    console.log('  Auto        | Tablica: przych.  koszt   marża      km | Grafik: przych.  koszt   marża      km | Δ marża')
    let sumB = 0
    let sumG = 0
    for (const t of view.trucks) {
      const gg = gt.find(x => x.plate === t.plate) ?? { rev: 0, sub: 0, margin: 0, km: 0 }
      sumB += t.totals.margin
      sumG += gg.margin
      console.log(
        `  ${t.plate.padEnd(11)} | ${eur(t.totals.revenue)} ${eur(t.totals.cost)} ${eur(t.totals.margin)} ${eur(t.totals.km)} | ${eur(gg.rev)} ${eur(gg.sub)} ${eur(gg.margin)} ${eur(gg.km)} | ${eur(t.totals.margin - gg.margin)}`,
      )
    }
    console.log(`  Marża działu (całe zlecenia): ${eur(view.kpis.margin)} · suma aut: ${eur(sumB)} · grafik: ${eur(sumG)}`)
  }
} finally {
  await db.destroy()
}
