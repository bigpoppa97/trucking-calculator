import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabase, migrateToLatest } from '../src/db/database.js'
import { readExport } from '../src/board/exportReader.js'
import { FROM_THE_BEGINNING } from '../src/board/drivers.js'
import { readGrafik } from '../src/board/grafik.js'
import { aliasKey } from '../src/board/normalize.js'
import { ensurePlaceSeed } from '../src/board/placeSeed.js'
import { importAirports } from '../src/import/importAirports.js'
import { loadDotEnv } from '../src/loadDotEnv.js'

loadDotEnv()

/**
 * One-off seeding of the board from the files you already have:
 *
 *   npm run board:seed -- --grafik "C:/…/Grafik podwykonawców.xlsm" [--export "C:/…/export.xlsx"] [--curtain PLATE,PLATE]
 *
 *  - fleet: the trucks of the LATEST week sheet (plate, trailer); "valid
 *    from" = first week the plate appears in the planner; their drivers go
 *    to the driver list (Flota → Kierowcy), valid from the beginning
 *  - carriers: from the export, if given (most frequent carrier per plate)
 *  - trailers: plates from row 3 of the last 26 weeks; cooler 2.61 m by
 *    default, plates listed in --curtain become curtain-siders 2.7 m
 *  - places: the built-in dictionary (airports + hubs)
 *
 * Existing records are never overwritten — safe to run again.
 * Personal data stays in your local database file; nothing is written to
 * the repository.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const grafikPath = arg('grafik')
const exportPath = arg('export')
const curtainPlates = new Set(
  (arg('curtain') ?? '')
    .split(',')
    .map(p => p.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean),
)
if (!grafikPath) {
  console.error('Użycie: npm run board:seed -- --grafik ścieżka/do/grafiku.xlsm [--export ścieżka/do/eksportu.xlsx] [--curtain NUMER,NUMER]')
  process.exit(1)
}

const databasePath = process.env['DATABASE_PATH'] ?? 'data/calculator.sqlite'
mkdirSync(dirname(databasePath), { recursive: true })
const db = createDatabase(databasePath)
try {
  await migrateToLatest(db)
  const airportCount = await db.selectFrom('airports').select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirst()
  if (Number(airportCount?.n ?? 0) === 0) {
    await importAirports(db, readFileSync('data/v1/airports.csv', 'utf-8'))
  }
  const placesAdded = await ensurePlaceSeed(db)
  console.log(`Słownik miejsc: dodano ${placesAdded} miejsc.`)

  const weeks = await readGrafik(grafikPath)
  const latest = weeks[weeks.length - 1]
  if (!latest) throw new Error('W grafiku nie znaleziono arkuszy tygodniowych z datami.')
  console.log(`Grafik: ${weeks.length} tygodni, ostatni od ${latest.weekStart} (${latest.sheet}).`)

  const firstSeen = new Map<string, string>()
  for (const w of weeks) for (const t of w.trucks) if (!firstSeen.has(t.plate)) firstSeen.set(t.plate, w.weekStart)

  const carriers = new Map<string, string>()
  if (exportPath) {
    const { rows } = await readExport(readFileSync(exportPath))
    const counts = new Map<string, Map<string, number>>()
    for (const r of rows) {
      if (!r.subPlate || !r.carrier) continue
      const m = counts.get(r.subPlate) ?? new Map<string, number>()
      m.set(r.carrier, (m.get(r.carrier) ?? 0) + 1)
      counts.set(r.subPlate, m)
    }
    for (const [plate, m] of counts) {
      const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0]
      if (best) carriers.set(plate, best[0])
    }
  }

  let order = 0
  for (const t of latest.trucks) {
    order++
    const exists = await db.selectFrom('board_truck_plates').select('id').where('plate', '=', t.plate).executeTakeFirst()
    if (exists) {
      console.log(`  ${t.plate}: już jest we flocie — pomijam.`)
      continue
    }
    const truck = await db
      .insertInto('board_trucks')
      .values({
        carrier: carriers.get(t.plate) ?? '',
        trailer_plate: t.trailer || null,
        sort_order: order,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('board_truck_plates')
      .values({ truck_id: truck.id, plate: t.plate, valid_from: firstSeen.get(t.plate) ?? latest.weekStart, valid_to: null })
      .execute()
    // Driver from the planner → driver list (same name and carrier = the same driver), valid from the beginning.
    const name = t.driver.replace(/\s+/g, ' ').trim()
    if (name) {
      const carrier = carriers.get(t.plate) ?? ''
      const existing = (await db.selectFrom('board_drivers').select(['id', 'name', 'carrier']).execute()).find(
        d => aliasKey(d.name) === aliasKey(name) && aliasKey(d.carrier) === aliasKey(carrier),
      )
      const driverId =
        existing?.id ??
        (
          await db
            .insertInto('board_drivers')
            .values({ name, phone: t.phone.replace(/\D/g, ''), carrier, created_at: new Date().toISOString() })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id
      await db
        .insertInto('board_driver_changes')
        .values({ truck_id: truck.id, driver_id: driverId, day: FROM_THE_BEGINNING, created_by: 'grafik', created_at: new Date().toISOString() })
        .onConflict(oc => oc.columns(['truck_id', 'day']).doNothing())
        .execute()
    }
    console.log(`  ${t.plate}: dodano (${carriers.get(t.plate) ?? 'przewoźnik do uzupełnienia'}), od ${firstSeen.get(t.plate)}.`)
  }

  const recent = weeks.slice(-26)
  const trailers = new Set<string>()
  for (const w of recent) for (const t of w.trucks) if (t.trailer) trailers.add(t.trailer)
  let trailersAdded = 0
  for (const plate of trailers) {
    const curtain = curtainPlates.has(plate)
    const res = await db
      .insertInto('board_trailers')
      .values({
        plate,
        type_pl: curtain ? 'plandeka 2,7 m · rolki' : 'chłodnia 2,61 m · rolki',
        type_en: curtain ? 'curtain 2.7m rollerbed' : 'cooler 2.61m rollerbed',
      })
      .onConflict(oc => oc.column('plate').doNothing())
      .executeTakeFirst()
    await db
      .insertInto('board_trailer_aliases')
      .values({ alias: plate, trailer_plate: plate })
      .onConflict(oc => oc.column('alias').doNothing())
      .execute()
    trailersAdded += Number(res.numInsertedOrUpdatedRows ?? 0)
  }
  console.log(`Naczepy: dodano ${trailersAdded} (z ${trailers.size} w ostatnich 26 tygodniach grafiku).`)
  console.log(`Baza: ${databasePath}`)
} finally {
  await db.destroy()
}
