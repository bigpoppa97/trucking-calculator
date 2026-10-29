import ExcelJS from 'exceljs'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import type { DB } from '../db/schema.js'
import { Migrator } from 'kysely/migration'
import { migrations } from '../db/migrations/index.js'
import { BoardService, type ServiceInput as ServiceInputT } from './boardService.js'
import { DistanceService } from './distances.js'
import { ExportFormatError, readExport } from './exportReader.js'
import { ensurePlaceSeed } from './placeSeed.js'
import { parseFleetList } from './fleetList.js'

/**
 * End-to-end tests of the board on synthetic exports (same columns as the
 * application's grid). Plates, carriers and amounts are made up.
 */

const HEADERS = [
  'Numer zlecenia',
  'Status zlecenia od klienta',
  'Zleceniodawca',
  'Kraj załadunku',
  'Miejsce załadunku',
  'Data załadunku',
  'Kraj dostawy',
  'Miejsce dostawy',
  'Zleceniobiorca',
  'Status zl spedycyjnego',
  'Data rozładunku',
  'Ciągnik',
  'Numer Obcy',
  'Fracht zakup',
  'Fracht sprzedaż',
  'Uwagi',
  'Ciągnik podwykonawcy',
  'Naczepa podwykonawcy',
]

interface Row {
  no: string
  status?: string
  client?: string
  from: string
  ld: string
  to: string
  ud: string
  carrier?: string
  statusSped?: string
  own?: string
  rev: number | null
  cost: number | null
  notes?: string
  sub?: string
  trailer?: string
  /** "Godziny załadunku" / "Godziny rozładunku" as the application writes them ("16:00 — —"). */
  lh?: string
  uh?: string
}

const HOURS_HEADERS = [...HEADERS, 'Godziny załadunku', 'Godziny rozładunku']

async function xlsx(rows: Row[], headers = HEADERS): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('ag-grid')
  ws.addRow(headers)
  for (const r of rows) {
    const byHeader: Record<string, unknown> = {
      'Numer zlecenia': r.no,
      'Status zlecenia od klienta': r.status ?? 'Z',
      Zleceniodawca: r.client ?? 'Klient Testowy',
      'Kraj załadunku': 'Polska (PL)',
      'Miejsce załadunku': r.from,
      'Data załadunku': r.ld,
      'Kraj dostawy': 'Węgry (HU)',
      'Miejsce dostawy': r.to,
      Zleceniobiorca: r.carrier ?? (r.sub ? 'Przewoźnik Alfa' : 'ZET LOGISTIC Sp.z o.o.'),
      'Status zl spedycyjnego': r.sub ? (r.statusSped ?? 'Z') : null,
      'Data rozładunku': r.ud,
      Ciągnik: r.own ?? null,
      'Numer Obcy': '1Z',
      'Fracht zakup': r.rev,
      'Fracht sprzedaż': r.cost,
      Uwagi: r.notes ?? null,
      'Ciągnik podwykonawcy': r.sub ?? null,
      'Naczepa podwykonawcy': r.trailer ?? null,
      'Godziny załadunku': r.lh ?? '— — —',
      'Godziny rozładunku': r.uh ?? '— — —',
    }
    ws.addRow(headers.map(h => byHeader[h] ?? null))
  }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

let db: Kysely<DB>
let distances: DistanceService
let now = '2026-09-27T18:00:00Z'
let board: BoardService
let filesDir: string

beforeEach(async () => {
  db = createTestDatabase()
  await migrateToLatest(db)
  await ensurePlaceSeed(db)
  distances = new DistanceService({ db, allowHere: false })
  now = '2026-09-27T18:00:00Z'
  filesDir = mkdtempSync(join(tmpdir(), 'tablica-pliki-'))
  board = new BoardService(db, distances, { now: () => now, actor: 'test', filesDir })
  // Fleet: two trucks of carrier Alfa, one of Beta; trailers.
  await board.createTruck({ plate: 'AA1001A', validFrom: '2026-01-01', carrier: 'Przewoźnik Alfa', driver: 'Jan K.', phone: '600100100', trailerPlate: 'TR100' })
  await board.createTruck({ plate: 'AA1002A', validFrom: '2026-01-01', carrier: 'Przewoźnik Alfa', driver: 'Ewa L.' })
  await board.createTruck({ plate: 'BB2001B', validFrom: '2026-01-01', carrier: 'Beta Trans', driver: 'Piotr M.' })
  for (const plate of ['TR100', 'TR200', 'TR960PE']) await board.upsertTrailer({ plate })
})

afterEach(async () => {
  await db.destroy()
  rmSync(filesDir, { recursive: true, force: true })
})

const issuesOf = async (kind?: string) => (await board.listIssues('open')).filter(i => !kind || i.kind === kind)

describe('export reader', () => {
  it('maps columns by name (order does not matter) and reverses the app naming of rates', async () => {
    const shuffled = [...HEADERS].reverse()
    const { rows } = await readExport(
      await xlsx([{ no: '79-1-26', from: 'WARSZAWA', ld: '2026-09-21', to: 'Vecsés', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA 1001A', trailer: 'tr100' }], shuffled),
    )
    expect(rows[0]).toMatchObject({ orderNo: '79-1-26', revEur: 1450, costEur: 1250, subPlate: 'AA1001A', loadDate: '2026-09-21' })
  })

  it('fails loudly when a required column is missing', async () => {
    const without = HEADERS.filter(h => h !== 'Fracht sprzedaż')
    await expect(readExport(await xlsx([], without))).rejects.toBeInstanceOf(ExportFormatError)
    await expect(readExport(await xlsx([], without))).rejects.toThrow(/Fracht sprzedaż/)
  })
})

describe('import', () => {
  it('takes fleet orders regardless of who issued them, skips own fleet and other carriers', async () => {
    const summary = await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'WARSZAWA', ld: '2026-09-21', to: 'Vecsés', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '101-2-26', from: 'Warszawa', ld: '2026-09-22', to: 'Wien', ud: '2026-09-23', rev: 1000, cost: 900, sub: 'BB2001B', carrier: 'Beta Trans', trailer: 'TR200' },
        { no: '79-3-26', from: 'Warszawa', ld: '2026-09-22', to: 'Praha 6 - Ruzyně', ud: '2026-09-23', rev: 900, cost: null, own: 'KN 5692K' },
        { no: '79-4-26', from: 'Warszawa', ld: '2026-09-22', to: 'Berlin', ud: '2026-09-23', rev: 900, cost: 800, sub: 'ZZ9999Z', carrier: 'Ktoś Inny' },
      ]),
      'eksport.xlsx',
      'daily',
    )
    expect(summary.created.sort()).toEqual(['101-2-26', '79-1-26'])
    expect(summary.rowsOwnFleet).toBe(1)
    expect(summary.rowsOtherCarriers).toBe(1)
    const own = await db.selectFrom('board_own_plates').selectAll().execute()
    expect(own.map(o => o.plate)).toEqual(['KN5692K'])
  })

  it('logs changes, flags disappeared orders within the file range and resolves them when they come back', async () => {
    const base: Row = { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' }
    const other: Row = { no: '79-2-26', from: 'Warszawa', ld: '2026-09-23', to: 'Budapest', ud: '2026-09-24', rev: 1400, cost: 1200, sub: 'AA1002A', trailer: 'TR200' }
    await board.importFile(await xlsx([base, other]), 'a.xlsx', 'daily')

    now = '2026-09-28T08:00:00Z'
    const second = await board.importFile(await xlsx([{ ...base, cost: 1300 }]), 'b.xlsx', 'daily')
    expect(second.updated).toEqual([{ orderNo: '79-1-26', changes: [{ field: 'cost_eur', from: '1250', to: '1300' }] }])
    // 79-2-26 (23.09) is outside the second file's range (only 21.09) → not flagged.
    expect(second.disappeared).toEqual([])

    const third = await board.importFile(await xlsx([{ ...base, cost: 1300 }, { ...other, no: '79-9-26', ld: '2026-09-25', ud: '2026-09-26' }]), 'c.xlsx', 'daily')
    expect(third.disappeared).toEqual(['79-2-26'])
    expect((await issuesOf('DISAPPEARED')).map(i => i.ref)).toEqual(['79-2-26'])

    await board.importFile(await xlsx([{ ...base, cost: 1300 }, other]), 'd.xlsx', 'daily')
    expect(await issuesOf('DISAPPEARED')).toEqual([])
  })

  it('treats an order moved to another carrier as gone from the board', async () => {
    const row: Row = { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' }
    await board.importFile(await xlsx([row]), 'a.xlsx', 'daily')
    const s = await board.importFile(await xlsx([{ ...row, sub: 'ZZ9999Z', carrier: 'Ktoś Inny' }]), 'b.xlsx', 'daily')
    expect(s.disappeared).toEqual(['79-1-26'])
  })

  it('asks once about a new tractor of a fleet carrier and remembers "ignore"', async () => {
    const rows: Row[] = [{ no: '79-5-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1000, cost: 900, sub: 'NEW123', carrier: 'Przewoźnik Alfa' }]
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily')
    const [issue] = await issuesOf('NEW_TRUCK')
    expect(issue?.ref).toBe('NEW123')
    await board.resolveIssue(issue!.id, 'ignore', {})
    await board.importFile(await xlsx(rows), 'b.xlsx', 'daily')
    expect(await issuesOf('NEW_TRUCK')).toEqual([])
  })

  it('a new plate for an existing truck takes over from the given day', async () => {
    const fleet = await board.fleet()
    const truck = fleet.find(t => t.currentPlate === 'AA1002A')!
    await board.addTruckPlate(truck.id, 'AA2002A', '2026-09-23')
    await board.importFile(
      await xlsx([
        { no: '79-6-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-22', rev: 1000, cost: 900, sub: 'AA1002A', trailer: 'TR200' },
        { no: '79-7-26', from: 'Budapest', ld: '2026-09-24', to: 'Warszawa', ud: '2026-09-25', rev: 1000, cost: 900, sub: 'AA2002A', trailer: 'TR200' },
      ]),
      'a.xlsx',
      'daily',
    )
    const week = await board.weekView('2026-09-21')
    const row = week.trucks.find(t => t.id === truck.id)!
    expect(row.bars.map(b => b.orderNo)).toEqual(['79-6-26', '79-7-26'])
    expect(row.plate).toBe('AA2002A')
  })
})

describe('trailer swaps (PRZ)', () => {
  it('relay with an own-fleet truck: own leg is outside the department, margin by the entry', async () => {
    await board.importFile(
      await xlsx([
        // own-fleet tractor seen elsewhere in the file → recognised as own fleet
        { no: '79-90-26', from: 'Warszawa', ld: '2026-09-08', to: 'Berlin', ud: '2026-09-08', rev: 900, cost: null, own: 'KN5692K' },
        {
          no: '101-2428-26',
          from: 'Ryga + Wilno',
          ld: '2026-09-09',
          to: 'Frankfurt am Main',
          ud: '2026-09-11',
          rev: 2583,
          cost: 1400,
          sub: 'BB2001B',
          carrier: 'Beta Trans',
          trailer: 'TR200',
          notes: 'LH7459S PRZ WAW 10.09 KN5692K>BB2001B 1183/1400',
        },
      ]),
      'a.xlsx',
      'daily',
    )
    const d = await board.orderDetails('101-2428-26')
    expect(d.order.margin).toBe(0)
    expect(d.legs.map(l => [l.plate, l.kind, l.from, l.to, l.amount])).toEqual([
      ['KN5692K', 'own', 'Ryga', 'Warszawa', 1183],
      ['BB2001B', 'fleet', 'Warszawa', 'Frankfurt', 1400],
    ])
    expect(await issuesOf('PRZ_AMOUNT_MISMATCH')).toEqual([])
    expect(await issuesOf('HIGH_MARGIN')).toEqual([])
  })

  it('two trucks of the same carrier on one forwarding order: amounts sum to the cost', async () => {
    await board.importFile(
      await xlsx([
        {
          no: '79-1315-26',
          from: 'Wien',
          ld: '2026-09-21',
          to: 'Wilno',
          ud: '2026-09-22',
          rev: 3620,
          cost: 2300,
          sub: 'AA1001A',
          trailer: 'TR100',
          notes: 'PRZ WAW 22.09 AA1001A>AA1002A 1400/900',
        },
      ]),
      'a.xlsx',
      'daily',
    )
    const d = await board.orderDetails('79-1315-26')
    expect(d.order.margin).toBe(1320)
    expect(d.legs.map(l => [l.plate, Math.round(l.revAlloc ?? 0)])).toEqual([
      ['AA1001A', 2203],
      ['AA1002A', 1417],
    ])
    expect(await issuesOf('PRZ_AMOUNT_MISMATCH')).toEqual([])
    const week = await board.weekView('2026-09-21')
    const second = week.trucks.find(t => t.plate === 'AA1002A')!
    expect(second.bars[0]).toMatchObject({ orderNo: '79-1315-26', prz: true, title: 'Warszawa → Wilno' })
    expect(second.events.some(e => e.auto && e.text.includes('przepinka'))).toBe(false) // first leg of this truck: nothing to compare
  })

  it('an own-fleet order whose second leg our truck drives comes onto the board through PRZ', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-80-26', from: 'Warszawa', ld: '2026-10-06', to: 'Frankfurt', ud: '2026-10-07', rev: 1600, cost: null, own: 'KN5692K', notes: 'PRZ WRO 06.10 KN5692K>AA1001A 800/800' },
      ]),
      'a.xlsx',
      'daily',
    )
    const d = await board.orderDetails('79-80-26')
    expect(d.order.margin).toBe(0)
    expect(d.legs[1]).toMatchObject({ plate: 'AA1001A', kind: 'fleet', from: 'Wrocław', to: 'Frankfurt' })
  })

  it('reports an unreadable entry and an unknown swap place, and learns the place once', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-11-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1000, cost: 500, sub: 'AA1001A', trailer: 'TR100', notes: 'PRZ GORZYCZKI 21.09 AA1001A AA1002A 500/400' },
        { no: '79-12-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1000, cost: 500, sub: 'AA1002A', trailer: 'TR200', notes: 'PRZ MOP Wiśniowa Góra 21.09 AA1002A>BB2001B 500/400' },
      ]),
      'a.xlsx',
      'daily',
    )
    expect((await issuesOf('PRZ_PARSE')).map(i => i.ref)).toEqual(['79-11-26'])
    const [place] = await issuesOf('PRZ_PLACE_UNKNOWN')
    expect(place?.ref).toBe('79-12-26')
    await board.resolveIssue(place!.id, 'new', { name: 'MOP Wiśniowa Góra', lat: 51.69, lon: 19.53, country: 'PL' })
    expect(await issuesOf('PRZ_PLACE_UNKNOWN')).toEqual([])
    const d = await board.orderDetails('79-12-26')
    expect(d.legs[0]?.to).toBe('MOP Wiśniowa Góra')
  })
})

describe('cancelled forwarding order and ferries (09.10.2026)', () => {
  it('a cancelled forwarding order without PRZ leaves the board: no bar, no review item, not counted', async () => {
    const rows: Row[] = [
      { no: '79-140-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-23', rev: 2000, cost: 1576, sub: 'AA1001A', trailer: 'TR100' },
      { no: '79-141-26', from: 'Budapest', ld: '2026-09-24', to: 'Warszawa', ud: '2026-09-25', rev: 2000, cost: 1576, sub: 'AA1001A', trailer: 'TR100' },
    ]
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily')
    // The carrier's order for 79-140-26 is cancelled (loaded by the own fleet instead).
    now = '2026-09-28T08:00:00Z'
    await board.importFile(await xlsx([{ ...rows[0]!, statusSped: 'A' }, rows[1]!]), 'b.xlsx', 'daily')

    const row = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1001A')!
    expect(row.bars.map(b => b.orderNo)).toEqual(['79-141-26'])
    expect(row.totals.revenue).toBe(2000)
    expect((await board.listIssues('open')).filter(i => i.ref === '79-140-26')).toEqual([])
    // The next order's empty run does not start at the cancelled order's unloading.
    expect((await board.orderDetails('79-141-26')).legs[0]?.kmEmptyFrom).toBeNull()

    // Still traceable on the truck page and in the order panel.
    const truckId = row.id
    const listed = (await board.truckView(truckId, '2026-09-21', '2026-09-27')).orders.find(o => o.orderNo === '79-140-26')
    expect(listed).toMatchObject({ noCarrier: true })
    expect((await board.orderDetails('79-140-26')).order.noCarrier).toBe(true)
  })

  it('PROM <amount> in the notes is a ferry cost: it lowers the margin and the truck result', async () => {
    const row: Row = { no: '79-143-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-24', rev: 2000, cost: 1000, sub: 'AA1002A', trailer: 'TR200' }
    await board.importFile(await xlsx([row]), 'a.xlsx', 'daily')
    expect((await issuesOf('HIGH_MARGIN')).map(i => i.ref)).toEqual(['79-143-26']) // 50 % without the ferry

    now = '2026-09-28T08:00:00Z'
    await board.importFile(await xlsx([{ ...row, notes: 'LH7411B-2026-09-22 PROM 300 Finnlines' }]), 'b.xlsx', 'daily')
    const d = await board.orderDetails('79-143-26')
    expect(d.order).toMatchObject({
      extraCost: 300,
      extraCostManual: false,
      ferryCost: 300,
      ferryEntries: ['PROM 300 Finnlines'],
      ferryErrors: [],
      amountsTotal: 1300,
      margin: 700,
    })
    expect(await issuesOf('HIGH_MARGIN')).toEqual([])
    const truck = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1002A')!
    expect(truck.totals.cost).toBe(1300)
    expect(truck.totals.margin).toBe(700)
    expect(truck.bars[0]?.margin).toBe(700)
  })

  it('an unreadable PROM entry goes to review and adds no cost', async () => {
    await board.importFile(
      await xlsx([{ no: '79-144-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-23', rev: 1500, cost: 1300, sub: 'AA1001A', trailer: 'TR100', notes: 'PROM 22.09' }]),
      'a.xlsx',
      'daily',
    )
    expect((await issuesOf('FERRY_PARSE')).map(i => i.ref)).toEqual(['79-144-26'])
    expect((await board.orderDetails('79-144-26')).order.margin).toBe(200)
  })

  it('a manual "Koszt dodatkowy" replaces the ferry until the application changes the PROM entry', async () => {
    const row: Row = { no: '79-145-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-24', rev: 2000, cost: 1000, sub: 'AA1002A', trailer: 'TR200', notes: 'PROM 300' }
    await board.importFile(await xlsx([row]), 'a.xlsx', 'daily')
    await board.setOverride('79-145-26', 'extra_cost', '350')
    expect((await board.orderDetails('79-145-26')).order).toMatchObject({ extraCost: 350, extraCostManual: true, ferryCost: 300, margin: 650 })

    now = '2026-09-28T08:00:00Z'
    await board.importFile(await xlsx([row]), 'b.xlsx', 'daily') // same PROM → correction stays
    expect((await board.orderDetails('79-145-26')).order.margin).toBe(650)

    await board.importFile(await xlsx([{ ...row, notes: 'PROM 320' }]), 'c.xlsx', 'daily') // PROM changed → application wins
    expect((await board.orderDetails('79-145-26')).order).toMatchObject({ extraCost: 320, extraCostManual: false, margin: 680 })
    expect((await issuesOf('OVERRIDE_SUPERSEDED')).map(i => i.ref)).toEqual(['79-145-26'])
  })

  it('a manual extra cost typed with a unit counts ("2350e"), and an unreadable one is refused', async () => {
    const row: Row = { no: '79-147-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-24', rev: 3720, cost: 1200, sub: 'AA1002A', trailer: 'TR200' }
    await board.importFile(await xlsx([row]), 'a.xlsx', 'daily')

    await board.setOverride('79-147-26', 'extra_cost', '2350e')
    let d = await board.orderDetails('79-147-26')
    expect(d.order).toMatchObject({ extraCost: 2350, margin: 170 })
    expect(d.overrides.find(o => o.field === 'extra_cost')?.display).toBe('2350')

    await expect(board.setOverride('79-147-26', 'extra_cost', '2350 zł')).rejects.toThrow(/kwotę w EUR liczbą/)
    await expect(board.setOverride('79-147-26', 'km_loaded', 'dużo')).rejects.toThrow(/liczbę kilometrów/)

    // Corrections saved before this check (stored as typed) are read too.
    await db.updateTable('board_overrides').set({ value: '2350e' }).where('order_no', '=', '79-147-26').where('field', '=', 'extra_cost').execute()
    d = await board.orderDetails('79-147-26')
    expect(d.order.margin).toBe(170)
    expect((await issuesOf('HIGH_MARGIN')).filter(i => i.ref === '79-147-26')).toEqual([])
  })

  it('PRZ and PROM in the same notes: both apply', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-146-26', from: 'Wien', ld: '2026-09-21', to: 'Wilno', ud: '2026-09-22', rev: 3620, cost: 2300, sub: 'AA1001A', trailer: 'TR100', notes: 'PRZ WAW 22.09 AA1001A>AA1002A 1400/900 PROM 120' },
      ]),
      'a.xlsx',
      'daily',
    )
    const d = await board.orderDetails('79-146-26')
    expect(d.order.prz).toMatchObject({ from: 'AA1001A', to: 'AA1002A' })
    expect(d.order.margin).toBe(1200)
    expect(await issuesOf('PRZ_PARSE')).toEqual([])
  })
})

describe('checks and corrections', () => {
  it('flags a suspicious margin and a per-km rate that looks like PLN', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-20-26', from: 'Gliwice', ld: '2026-09-14', to: 'Wien', ud: '2026-09-14', rev: 3510.04, cost: 750, sub: 'AA1001A', trailer: 'TR100' },
      ]),
      'a.xlsx',
      'daily',
    )
    const kinds = (await issuesOf()).map(i => i.kind).sort()
    expect(kinds).toEqual(['HIGH_MARGIN', 'REV_PER_KM'])
  })

  it('a manual correction stays until the application changes the same value', async () => {
    const row: Row = { no: '79-30-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' }
    await board.importFile(await xlsx([row]), 'a.xlsx', 'daily')
    await board.setOverride('79-30-26', 'cost', '1350')
    expect((await board.orderDetails('79-30-26')).order.margin).toBe(100)

    now = '2026-09-28T08:00:00Z'
    await board.importFile(await xlsx([row]), 'b.xlsx', 'daily') // app unchanged → correction stays
    expect((await board.orderDetails('79-30-26')).order.margin).toBe(100)

    await board.importFile(await xlsx([{ ...row, cost: 1300 }]), 'c.xlsx', 'daily') // app changed → app wins
    expect((await board.orderDetails('79-30-26')).order.margin).toBe(150)
    expect((await issuesOf('OVERRIDE_SUPERSEDED')).map(i => i.ref)).toEqual(['79-30-26'])
  })

  it('suggests the known trailer for a typo and resolves after an alias', async () => {
    await board.importFile(
      await xlsx([{ no: '79-40-26', from: 'Frankfurt', ld: '2026-09-21', to: 'Katowice', ud: '2026-09-22', rev: 2120, cost: 1497.2, sub: 'BB2001B', carrier: 'Beta Trans', trailer: 'TR96PE' }]),
      'a.xlsx',
      'daily',
    )
    const [issue] = await issuesOf('UNKNOWN_TRAILER')
    expect(issue?.details['suggestions']).toEqual(['TR960PE'])
    await board.resolveIssue(issue!.id, 'alias', { trailer: 'TR960PE' })
    expect(await issuesOf('UNKNOWN_TRAILER')).toEqual([])
  })

  it('cancelled and unconfirmed orders are shown but not counted', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-50-26', status: 'A', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-51-26', status: 'N', from: 'Warszawa', ld: '2026-09-23', to: 'Budapest', ud: '2026-09-24', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-52-26', from: 'Budapest', ld: '2026-09-25', to: 'Warszawa', ud: '2026-09-26', rev: 1100, cost: 900, sub: 'AA1001A', trailer: 'TR100' },
      ]),
      'a.xlsx',
      'daily',
    )
    const week = await board.weekView('2026-09-24')
    expect(week.kpis.orders).toBe(1)
    expect(week.kpis.margin).toBe(200)
    const truck = week.trucks.find(t => t.plate === 'AA1001A')!
    expect(truck.bars.map(b => [b.orderNo, b.excluded])).toEqual([
      ['79-50-26', 'cancelled'],
      ['79-51-26', 'unconfirmed'],
      ['79-52-26', null],
    ])
  })
})

describe('kilometres', () => {
  it('counts the empty run from the previous unloading, or from a position note', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-60-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-61-26', from: 'Wien', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR100' },
      ]),
      'a.xlsx',
      'daily',
    )
    let d = await board.orderDetails('79-61-26')
    expect(d.legs[0]?.kmEmptyFrom).toBe('Budapeszt (Vecsés)')
    expect(d.legs[0]?.kmEmpty).toBeGreaterThan(150) // Budapest → Vienna ≈ 250 km by road
    expect(d.legs[0]?.kmEstimated).toBe(true) // no HERE in tests

    const truck = (await board.fleet()).find(t => t.currentPlate === 'AA1001A')!
    // A service never moves the start of the empty run (08.10.2026: km corrections are manual)…
    await board.createService({ truckId: truck.id, target: 'truck', status: 'planned', allDay: true, startDay: '2026-09-22', endDay: '2026-09-22', place: 'Bratislava' })
    d = await board.orderDetails('79-61-26')
    expect(d.legs[0]?.kmEmptyFrom).toBe('Budapeszt (Vecsés)')
    // …a position event with a place does.
    await board.addTruckEvent({ truckId: truck.id, day: '2026-09-22', kind: 'position', text: 'Pozycja', place: 'Bratislava' })
    d = await board.orderDetails('79-61-26')
    expect(d.legs[0]?.kmEmptyFrom).toBe('Bratysława')
    await expect(board.addTruckEvent({ truckId: truck.id, day: '2026-09-22', kind: 'service', text: 'Serwis' })).rejects.toThrow(/formularzem serwisu/)

    await board.setDistance('BTS', 'VIE', 80, 'sprawdzone')
    d = await board.orderDetails('79-61-26')
    expect(d.legs[0]?.kmEmpty).toBe(80)
  })

  it('a manual km pair from the calculator route database wins over estimates', async () => {
    await db
      .insertInto('routes')
      .values({ route_code: 'WAW-BUD', stops: '["WAW","BUD"]', total_km: 777, km_source: 'manual', created_by: 'test' })
      .execute()
    await board.importFile(
      await xlsx([{ no: '79-70-26', from: 'Warszawa', ld: '2026-09-21', to: 'Vecses', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' }]),
      'a.xlsx',
      'daily',
    )
    const d = await board.orderDetails('79-70-26')
    expect(d.legs[0]?.kmLoaded).toBe(777)
    expect(d.legs[0]?.kmEstimated).toBe(false)
  })
})

describe('notes', () => {
  it('board notes stick to the order number across imports', async () => {
    const row: Row = { no: '79-80-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' }
    await board.importFile(await xlsx([row]), 'a.xlsx', 'daily')
    await board.addOrderNote('79-80-26', 'Awizacja 2 h przed')
    await board.importFile(await xlsx([{ ...row, notes: '224R' }]), 'b.xlsx', 'daily')
    const week = await board.weekView('2026-09-21')
    const bar = week.trucks.find(t => t.plate === 'AA1001A')!.bars[0]!
    expect(bar.noteLines).toEqual(['Z aplikacji: 224R', expect.stringContaining('Awizacja 2 h przed')])
  })
})

describe('fleet list (trailers belong to carriers)', () => {
  const LIST = `Alfa:
Ciągniki: AA1001A, AA 1002A
Naczepy: TR100, tr200

Beta:
Ciągnik: BB2001B
Naczepa: TR960PE
`

  it('parses the pasted list in the department format', () => {
    expect(parseFleetList(LIST)).toEqual({
      blocks: [
        { name: 'Alfa', tractors: ['AA1001A', 'AA1002A'], trailers: ['TR100', 'TR200'] },
        { name: 'Beta', tractors: ['BB2001B'], trailers: ['TR960PE'] },
      ],
      errors: [],
    })
    expect(parseFleetList('Naczepy: X1').errors[0]).toMatch(/przed nazwą przewoźnika/)
    expect(parseFleetList('Gamma:\nNaczepy: X1').errors[0]).toMatch(/nie ma linii „Ciągniki/)
  })

  it('shows the plan first, then assigns trailers to carriers, fixes single sets and retires the rest', async () => {
    await board.upsertTrailer({ plate: 'OLD1' })
    const dry = await board.syncFleetList(LIST, false)
    expect(dry.applied).toBe(false)
    expect(dry.errors).toEqual([])
    expect(dry.warnings).toEqual([])
    expect(dry.changes).toEqual([
      'TR100: przewoźnik Przewoźnik Alfa.',
      'TR200: przewoźnik Przewoźnik Alfa.',
      'AA1001A: bez stałej naczepy (było TR100) — naczepy przewoźnika rotują, tablica pokaże naczepę z ostatniego zlecenia.',
      'TR960PE: przewoźnik Beta Trans.',
      'BB2001B: stała naczepa TR960PE.',
      'OLD1: wycofana z floty (ostatni dzień 26.09.2026).',
    ])
    expect((await db.selectFrom('board_trailers').select('carrier').where('plate', '=', 'TR100').executeTakeFirstOrThrow()).carrier).toBe('')

    const done = await board.syncFleetList(LIST, true)
    expect(done.applied).toBe(true)
    const trailers = await board.trailers()
    expect(trailers.map(t => [t.plate, t.carrier, t.activeTo])).toEqual(
      expect.arrayContaining([
        ['TR100', 'Przewoźnik Alfa', null],
        ['TR200', 'Przewoźnik Alfa', null],
        ['TR960PE', 'Beta Trans', null],
        ['OLD1', '', '2026-09-26'],
      ]),
    )
    const fleet = await board.fleet()
    expect(fleet.map(t => [t.currentPlate, t.trailerPlate])).toEqual([
      ['AA1001A', null],
      ['AA1002A', null],
      ['BB2001B', 'TR960PE'],
    ])
    expect((await board.syncFleetList(LIST, false)).changes).toEqual([])
  })

  it('reports tractors it cannot place and refuses duplicates', async () => {
    const plan = await board.syncFleetList('Alfa:\nCiągniki: AA1001A, CC3003C\nNaczepy: TR100', false)
    expect(plan.warnings.join('\n')).toMatch(/CC3003C .*nie ma w bazie/)
    expect(plan.warnings.join('\n')).toMatch(/AA1002A .*nie ma go na liście/)
    expect(plan.warnings.join('\n')).toMatch(/BB2001B .*nie ma go na liście/)
    const dup = await board.syncFleetList('Alfa:\nCiągniki: AA1001A\nNaczepy: TR100\nBeta:\nCiągniki: BB2001B\nNaczepy: TR100', true)
    expect(dup.applied).toBe(false)
    expect(dup.errors[0]).toMatch(/TR100 jest na liście dwa razy/)
  })

  it('flags a retired trailer only on orders loaded after it left the fleet, and suggests the carrier pool', async () => {
    await board.upsertTrailer({ plate: 'OLD1' })
    await board.syncFleetList(LIST, true) // OLD1 last day 26.09
    await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'Warszawa', ld: '2026-09-25', to: 'Budapest', ud: '2026-09-26', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'OLD1' },
        { no: '79-2-26', from: 'Warszawa', ld: '2026-09-27', to: 'Budapest', ud: '2026-09-28', rev: 1450, cost: 1250, sub: 'AA1002A', trailer: 'OLD1' },
        { no: '79-3-26', from: 'Warszawa', ld: '2026-09-27', to: 'Wien', ud: '2026-09-28', rev: 1000, cost: 900, sub: 'AA1001A' },
        { no: '79-4-26', from: 'Warszawa', ld: '2026-09-27', to: 'Wien', ud: '2026-09-28', rev: 1000, cost: 900, sub: 'AA1001A', trailer: 'TRX9' },
      ]),
      'e.xlsx',
      'daily',
    )
    const unknown = await issuesOf('UNKNOWN_TRAILER')
    const retired = unknown.find(i => i.ref === 'OLD1')
    expect(retired?.message).toBe('Naczepy „OLD1” nie ma już we flocie (do 26.09), a jest w zleceniu: 79-2-26.')
    expect(retired?.details).toMatchObject({ retired: 'OLD1', suggestions: [] })
    const fresh = unknown.find(i => i.ref === 'TRX9')
    expect(fresh?.details).toMatchObject({ retired: null, suggestions: ['TR100', 'TR200'], carrier: 'Przewoźnik Alfa' })
    const missing = await issuesOf('MISSING_TRAILER')
    expect(missing[0]?.details).toMatchObject({ pool: ['TR100', 'TR200'], lastKnown: null })

    // Bringing the retired trailer back clears the flag.
    await board.resolveIssue(retired!.id, 'new', {})
    expect((await issuesOf('UNKNOWN_TRAILER')).map(i => i.ref)).toEqual(['TRX9'])
    expect((await board.trailers()).find(t => t.plate === 'OLD1')?.activeTo).toBeNull()
  })
})

describe('services (serwis)', () => {
  // now = Sunday 27.09.2026, 20:00 in Poland
  const rows: Row[] = [
    { no: '79-90-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-23', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
    { no: '79-91-26', from: 'Budapest', ld: '2026-09-24', to: 'Warszawa', ud: '2026-09-25', rev: 1200, cost: 1000, sub: 'AA1002A', trailer: 'TR200' },
  ]
  const truckId = async (plate: string) => (await board.fleet()).find(t => t.currentPlate === plate)!.id
  const row = async (plate: string, date = '2026-09-21') => (await board.weekView(date)).trucks.find(t => t.plate === plate)!

  it('a required service waits at the truck, then is planned, moved, postponed and cancelled with a history', async () => {
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily')
    const t1 = await truckId('AA1001A')
    await expect(board.createService({ truckId: t1, target: 'truck', status: 'required' })).rejects.toThrow(/co trzeba zrobić/)
    const id = await board.createService({ truckId: t1, target: 'truck', status: 'required', description: 'olej', place: 'Kraków' })
    let r = await row('AA1001A')
    expect(r.required.map(s => [s.description, s.place, s.phase])).toEqual([['olej', 'Kraków', 'required']])
    expect(r.services).toEqual([])

    // Zaplanuj: the same record gets hours; a short stop during an order is not a conflict.
    await board.updateService(id, { status: 'planned', startDay: '2026-09-22', startTime: '10:00', endDay: '2026-09-22', endTime: '13:00' })
    r = await row('AA1001A')
    expect(r.required).toEqual([])
    expect(r.services.map(s => [s.id, s.when, s.phase])).toEqual([[id, '22.09 10:00–13:00', 'done']])
    expect(r.bars[0]?.serviceConflict).toBeNull()

    await board.updateService(id, { startDay: '2026-09-28', endDay: '2026-09-28' })
    await board.updateService(id, { status: 'required' })
    expect((await row('AA1001A')).required.map(s => s.id)).toEqual([id])
    await board.updateService(id, { status: 'cancelled' })
    expect((await row('AA1001A')).required).toEqual([])

    const svc = (await board.truckView(t1, '2026-09-21', '2026-09-27')).services.find(s => s.id === id)!
    expect(svc.phase).toBe('cancelled')
    expect(svc.history.map(h => h.text)).toEqual([
      'Zgłoszono serwis wymagany (ciągnik: olej).',
      'Zaplanowano: 22.09 10:00–13:00.',
      'Przesunięto: 22.09 10:00–13:00 → 28.09 10:00–13:00.',
      'Odłożono — wraca do wymaganych (było 28.09 10:00–13:00).',
      'Odwołano.',
    ])
    expect(svc.history[0]?.by).toBe('test')
    await expect(board.updateService(id, { description: 'x' })).rejects.toThrow(/najpierw przywróć/)

    await board.deleteService(id)
    expect((await board.truckView(t1, '2026-09-21', '2026-09-27')).services.find(s => s.id === id)).toBeUndefined()
    await expect(board.updateService(id, { description: 'x' })).rejects.toThrow(/Nie ma takiego serwisu/)
  })

  it('outlines an order only on a day the truck spends wholly in service', async () => {
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily')
    const t1 = await truckId('AA1001A')
    const t2 = await truckId('AA1002A')
    await board.createService({ truckId: t1, target: 'truck', status: 'planned', startDay: '2026-09-21', startTime: '08:00', endDay: '2026-09-21', endTime: '18:00' })
    expect((await row('AA1001A')).bars[0]?.serviceConflict).toBeNull()

    // Tue 14:00 → Thu 10:00: Wednesday (an order day) is covered from midnight to midnight.
    await board.createService({ truckId: t1, target: 'truck', status: 'planned', startDay: '2026-09-22', startTime: '14:00', endDay: '2026-09-24', endTime: '10:00' })
    const bar = (await row('AA1001A')).bars[0]!
    expect(bar.serviceConflict).toBe('Auto w serwisie cały dzień 23.09.')
    expect(bar.noteLines[0]).toBe('Auto w serwisie cały dzień 23.09.')

    await board.createService({ truckId: t2, target: 'truck', status: 'planned', allDay: true, startDay: '2026-09-25', endDay: '2026-09-26' })
    const r2 = await row('AA1002A')
    expect(r2.bars[0]?.serviceConflict).toBe('Auto w serwisie cały dzień 25.09.')
    expect(r2.services[0]?.when).toBe('25.09–26.09, całe dni')
  })

  it('a trailer service follows the trailer, not the tractor it was entered at', async () => {
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily')
    const t1 = await truckId('AA1001A')
    await expect(board.createService({ truckId: t1, target: 'trailer', status: 'required', description: 'agregat', trailerPlate: 'XX999' })).rejects.toThrow(
      /Nie znam naczepy XX999/,
    )
    // Entered at AA1001A, but TR200 is behind AA1002A → the badge shows there.
    await board.createService({ truckId: t1, target: 'trailer', status: 'required', description: 'agregat', trailerPlate: 'tr 200' })
    expect((await row('AA1001A')).required).toEqual([])
    expect((await row('AA1002A')).required.map(s => [s.trailerPlate, s.description])).toEqual([['TR200', 'agregat']])
    expect((await board.requiredServices()).map(s => s.trailerPlate)).toEqual(['TR200'])
    expect((await board.truckView(t1, '2026-09-21', '2026-09-27')).services.filter(s => s.trailerPlate === 'TR200')).toEqual([])
    expect((await board.truckView(await truckId('AA1002A'), '2026-09-21', '2026-09-27')).services.map(s => s.description)).toEqual(['agregat'])

    // A fixed trailer on another tractor does not duplicate the badge: the latest order with the trailer wins.
    await board.updateTruck(await truckId('BB2001B'), { trailerPlate: 'TR100' })
    await board.createService({ truckId: t1, target: 'trailer', status: 'required', description: 'przegląd naczepy', trailerPlate: 'TR100' })
    expect((await row('AA1001A')).required.map(s => s.trailerPlate)).toEqual(['TR100'])
    expect((await row('BB2001B')).required).toEqual([])
    await board.updateTruck(await truckId('BB2001B'), { trailerPlate: null })

    // Planned on Saturday: TR100 is behind AA1001A by then (its last order) — shown in its strip, never a conflict.
    await board.createService({ truckId: await truckId('BB2001B'), target: 'trailer', trailerPlate: 'TR100', status: 'planned', allDay: true, startDay: '2026-09-21', endDay: '2026-09-21' })
    const r1 = await row('AA1001A')
    expect(r1.services.map(s => [s.target, s.trailerPlate])).toEqual([['trailer', 'TR100']])
    expect(r1.bars[0]?.serviceConflict).toBeNull()
    expect((await row('BB2001B')).services).toEqual([])
  })

  it('checks the dates', async () => {
    const t1 = await truckId('AA1001A')
    const planned = (w: Partial<ServiceInputT>) => board.createService({ truckId: t1, target: 'truck', status: 'planned', ...w })
    await expect(planned({ startDay: '2026-09-22', endDay: '2026-09-22' })).rejects.toThrow(/Podaj godziny/)
    await expect(planned({ startDay: '2026-09-22', startTime: '12:00', endDay: '2026-09-22', endTime: '10:00' })).rejects.toThrow(/po początku/)
    await expect(planned({ allDay: true, startDay: '2026-09-22', endDay: '2026-09-21' })).rejects.toThrow(/przed pierwszym/)
    await expect(planned({ allDay: true, startDay: '2026-09-22', endDay: '2027-09-22' })).rejects.toThrow(/dłuższy niż 60 dni/)
    await expect(planned({ allDay: true })).rejects.toThrow(/Podaj daty/)
    await expect(planned({ allDay: true, startDay: '2026-02-30', endDay: '2026-03-01' })).rejects.toThrow(/Podaj daty/)
    await expect(board.truckView(t1, '2026-13-01', '2026-13-01')).rejects.toThrow(/poprawną datę/)
  })

  it('the set page covers whole weeks with totals, orders, services and the active order', async () => {
    now = '2026-09-28T09:00:00Z'
    await board.importFile(
      await xlsx([...rows, { no: '79-92-26', from: 'Warszawa', ld: '2026-09-30', to: 'Wien', ud: '2026-10-01', rev: 900, cost: 800, sub: 'AA1001A', trailer: 'TR100' }]),
      'a.xlsx',
      'daily',
    )
    const t1 = await truckId('AA1001A')
    await board.createService({ truckId: t1, target: 'truck', status: 'planned', startDay: '2026-09-22', startTime: '10:00', endDay: '2026-09-22', endTime: '12:00' })
    await board.createService({ truckId: t1, target: 'truck', status: 'required', description: 'opony' })

    const month = await board.truckView(t1, '2026-09-01', '2026-09-30')
    expect(month.weeks.map(w => w.weekStart)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'])
    expect(month.from).toBe('2026-08-31')
    expect(month.to).toBe('2026-10-04')
    expect(month.orders.map(o => o.orderNo)).toEqual(['79-90-26', '79-92-26'])
    expect(month.totals).toMatchObject({ revenue: 2350, cost: 2050, margin: 300, legs: 2, services: 1 })
    expect(month.truck).toMatchObject({ plate: 'AA1001A', carrier: 'Przewoźnik Alfa', trailer: 'TR100' })
    expect(month.truck.required.map(s => s.description)).toEqual(['opony'])
    expect(month.services.map(s => s.phase)).toEqual(['required', 'done'])
    expect(month.activeOrder).toMatchObject({ orderNo: '79-92-26', upcoming: true })

    const week = await board.truckView(t1, '2026-09-23', '2026-09-23')
    expect(week.weeks).toHaveLength(1)
    expect(week.totals.revenue).toBe(1450)
    await expect(board.truckView(999, '2026-09-23', '2026-09-23')).rejects.toThrow(/Nie ma takiego auta/)
  })
})

describe('migration 0011', () => {
  it('turns old single-day "Serwis" events into all-day planned services', async () => {
    const raw = createTestDatabase()
    try {
      const migrator = new Migrator({ db: raw, provider: { getMigrations: async () => migrations } })
      await migrator.migrateTo('0010_trailer_carrier')
      const truck = await raw.insertInto('board_trucks').values({ carrier: 'Alfa' }).returning('id').executeTakeFirstOrThrow()
      await raw.insertInto('board_places').values({ code: 'KRK', name: 'Kraków', lat: 50.07, lon: 19.8, kind: 'airport' }).execute()
      await raw
        .insertInto('board_notes')
        .values({ scope: 'truck_day', truck_id: truck.id, day: '2026-10-01', kind: 'service', text: 'olej', place_code: 'KRK', created_by: 'Dyspozytor', created_at: '2026-09-30T10:00:00Z' })
        .execute()
      await raw
        .insertInto('board_notes')
        .values({ scope: 'truck_day', truck_id: truck.id, day: '2026-10-01', kind: 'pause', text: 'pauza', created_by: 'Dyspozytor', created_at: '2026-09-30T10:00:00Z' })
        .execute()
      await migrateToLatest(raw)
      const services = await raw.selectFrom('board_services').selectAll().execute()
      expect(services.map(s => [s.status, s.all_day, s.start_day, s.end_day, s.description, s.place, s.created_by])).toEqual([
        ['planned', 1, '2026-10-01', '2026-10-01', 'olej', 'Kraków', 'Dyspozytor'],
      ])
      const notes = await raw.selectFrom('board_notes').select(['kind', 'deleted']).orderBy('id').execute()
      expect(notes).toEqual([
        { kind: 'service', deleted: 1 },
        { kind: 'pause', deleted: 0 },
      ])
    } finally {
      await raw.destroy()
    }
  })
})

describe('drivers (kierowcy)', () => {
  const truckId = async (plate: string) => (await board.fleet()).find(t => t.currentPlate === plate)!.id
  const rowOf = async (plate: string, date = '2026-09-21') => (await board.weekView(date)).trucks.find(t => t.plate === plate)!

  it('tractors added with a driver put him on the driver list, valid from the beginning', async () => {
    const drivers = await board.drivers()
    // Sorted by carrier, then name.
    expect(drivers.map(d => [d.name, d.carrier, d.trucks.map(t => t.plate)])).toEqual([
      ['Piotr M.', 'Beta Trans', ['BB2001B']],
      ['Ewa L.', 'Przewoźnik Alfa', ['AA1002A']],
      ['Jan K.', 'Przewoźnik Alfa', ['AA1001A']],
    ])
    const row = await rowOf('AA1001A')
    expect(row).toMatchObject({ driver: 'Jan K.', phone: '600100100' })
    expect(row.copyText).toBe('Truck AA1001A, Trailer TR100 (cooler 2.61m rollerbed), Driver: Jan K. 600 100 100')
    expect((await board.fleet())[0]).not.toHaveProperty('phone')
    await expect(board.createDriver({ name: ' jan  k. ', carrier: 'Przewoźnik Alfa' })).rejects.toThrow(/już jest na liście/)
  })

  it('a driver change shows from its day; the week shows who finished it; a move frees the other tractor', async () => {
    const t1 = await truckId('AA1001A')
    const t2 = await truckId('AA1002A')
    const krzys = await board.createDriver({ name: 'Krzysztof Z.', phone: '600999999', carrier: 'Przewoźnik Alfa' })
    // Saturday 26.09 Krzysztof takes over AA1001A.
    await board.setDriverChange({ truckId: t1, day: '2026-09-26', driverId: krzys })
    const week39 = await rowOf('AA1001A', '2026-09-21')
    expect(week39.driver).toBe('Krzysztof Z.') // today (27.09) is in week 39 → the driver today
    expect(week39.events.filter(e => e.kind === 'driver').map(e => [e.day, e.text])).toEqual([['2026-09-26', 'Kierowca: Jan K. → Krzysztof Z.']])
    expect((await rowOf('AA1001A', '2026-09-14')).driver).toBe('Jan K.')

    // One change per tractor and day: the second replaces the first.
    await board.setDriverChange({ truckId: t1, day: '2026-09-26', driverId: krzys })
    expect((await board.truckView(t1, '2026-09-21', '2026-09-21')).truck.driverChanges.map(c => c.day)).toEqual(['2026-09-26', '2000-01-01'])

    // Krzysztof moves to AA1002A on 01.10 and leaves AA1001A without a driver.
    const moved = await board.setDriverChange({ truckId: t2, day: '2026-10-01', driverId: krzys, releaseOther: true })
    expect(moved.released).toEqual(['AA1001A'])
    expect((await rowOf('AA1001A', '2026-10-05')).driver).toBe('')
    expect((await rowOf('AA1002A', '2026-10-05')).driver).toBe('Krzysztof Z.')
    const history = (await board.driverDetails(krzys)).history
    expect(history.map(h => [h.plate, h.from, h.to])).toEqual([
      ['AA1002A', '2026-10-01', null],
      ['AA1001A', '2026-09-26', '2026-09-30'],
    ])

    const change = (await board.truckView(t2, '2026-10-01', '2026-10-01')).truck.driverChanges[0]!
    await board.updateDriverChange(change.id, { day: '2026-10-02' })
    await expect(board.updateDriverChange(change.id, { day: '2000-01-01' })).rejects.toThrow(/ma już zmianę kierowcy/)
    await board.deleteDriverChange(change.id)
    expect((await rowOf('AA1002A', '2026-10-05')).driver).toBe('Ewa L.')
    await expect(board.setDriverChange({ truckId: t1, day: '2026-02-30', driverId: krzys })).rejects.toThrow(/poprawną datę/)
  })

  it('the driver of an order: a change between loading and unloading names both; on the loading day the new one; on the unloading day the old one', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-201-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-24', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-202-26', from: 'Budapest', ld: '2026-09-25', to: 'Warszawa', ud: '2026-09-26', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR100' },
      ]),
      'a.xlsx',
      'daily',
    )
    const t1 = await truckId('AA1001A')
    const krzys = await board.createDriver({ name: 'Krzysztof Z.', carrier: 'Przewoźnik Alfa' })
    await board.setDriverChange({ truckId: t1, day: '2026-09-23', driverId: krzys })
    let d = await board.orderDetails('79-201-26')
    expect(d.legs[0]).toMatchObject({ driver: 'Jan K. → Krzysztof Z. (zmiana 23.09)', driverManual: false })

    // Change moved to the unloading day 24.09 → the old driver did the whole order, the new one the next.
    const change = (await board.truckView(t1, '2026-09-21', '2026-09-21')).truck.driverChanges[0]!
    await board.updateDriverChange(change.id, { day: '2026-09-24' })
    expect((await board.orderDetails('79-201-26')).legs[0]?.driver).toBe('Jan K.')
    // On the loading day of 79-202-26 (25.09) → the new driver.
    await board.updateDriverChange(change.id, { day: '2026-09-25' })
    expect((await board.orderDetails('79-202-26')).legs[0]?.driver).toBe('Krzysztof Z.')
    expect((await board.truckView(t1, '2026-09-21', '2026-09-27')).orders.map(o => [o.orderNo, o.driver])).toEqual([
      ['79-201-26', 'Jan K.'],
      ['79-202-26', 'Krzysztof Z.'],
    ])

    // Manual correction (driver id) wins; an unknown id is refused.
    await expect(board.setOverride('79-201-26', 'driver', '999')).rejects.toThrow(/Wybierz kierowcę/)
    await board.setOverride('79-201-26', 'driver', String(krzys))
    d = await board.orderDetails('79-201-26')
    expect(d.legs[0]).toMatchObject({ driver: 'Krzysztof Z.', driverManual: true })
    expect(d.overrides.find(o => o.field === 'driver')?.display).toBe('Krzysztof Z.')
  })

  it('certificates: newest per kind decides, yellow 30 days before the end, red after it', async () => {
    const jan = (await board.drivers()).find(d => d.name === 'Jan K.')!.id
    const old = await board.createCert(jan, { kind: 'avsec', number: 'A-1', validTo: '2026-09-01' })
    expect((await rowOf('AA1001A')).driverWarnings).toEqual([{ kind: 'AVSEC', validTo: '2026-09-01', status: 'expired' }])
    await board.createCert(jan, { kind: 'AVSEC', number: 'A-2', validTo: '2026-10-20' })
    expect((await rowOf('AA1001A')).driverWarnings).toEqual([{ kind: 'AVSEC', validTo: '2026-10-20', status: 'expiring' }])
    await board.updateCert(old, { validTo: '2027-09-01' })
    expect((await rowOf('AA1001A')).driverWarnings).toEqual([])
    const list = await board.drivers()
    expect(list.find(d => d.id === jan)?.avsec).toMatchObject({ validTo: '2027-09-01', number: 'A-1', status: 'ok' })
    await expect(board.createCert(jan, { kind: '  ', validTo: null })).rejects.toThrow(/rodzaj certyfikatu/)
    await expect(board.createCert(jan, { kind: 'ADR', validTo: '2026-13-01' })).rejects.toThrow(/datę ważności/)
  })

  it('scans: only PDF/JPG/PNG, stored on disk next to the database, removed with the certificate', async () => {
    const jan = (await board.drivers()).find(d => d.name === 'Jan K.')!.id
    const cert = await board.createCert(jan, { kind: 'AVSEC', validTo: '2027-01-31' })
    const pdf = new TextEncoder().encode('%PDF-1.4\n% test\n')
    await expect(board.addCertFile(cert, 'virus.exe', new TextEncoder().encode('MZ....'))).rejects.toThrow(/PDF, JPG albo PNG/)
    const fileId = await board.addCertFile(cert, 'C:\\Users\\x\\AVSEC Jan.pdf', pdf)
    const details = await board.driverDetails(jan)
    expect(details.certs[0]?.files.map(f => [f.filename, f.mime, f.size, f.uploadedBy])).toEqual([['AVSEC Jan.pdf', 'application/pdf', pdf.length, 'test']])
    const file = await board.certFile(fileId)
    expect(file.data.toString()).toBe('%PDF-1.4\n% test\n')
    const stored = (await db.selectFrom('board_driver_cert_files').select('stored_name').executeTakeFirstOrThrow()).stored_name
    expect(readdirSync(join(filesDir, 'certyfikaty'))).toEqual([stored])

    await board.deleteCert(cert)
    expect(readdirSync(join(filesDir, 'certyfikaty'))).toEqual([])
    await expect(board.certFile(fileId)).rejects.toThrow(/Nie ma takiego pliku/)
  })

  it('a fixed trailer is set from the trailer list; a tractor keeps one', async () => {
    const t3 = await truckId('BB2001B')
    await board.setTrailerFixedTruck('TR960PE', t3)
    await board.setTrailerFixedTruck('TR200', t3)
    const trailers = await board.trailers()
    expect(trailers.filter(t => t.fixedTruckId !== null).map(t => [t.plate, t.fixedTruckPlate])).toEqual([
      ['TR100', 'AA1001A'],
      ['TR200', 'BB2001B'],
    ])
    await board.setTrailerFixedTruck('TR200', null)
    expect((await board.fleet()).find(t => t.id === t3)?.trailerPlate).toBeNull()
  })
})

describe('migration 0012', () => {
  it('moves the drivers of the tractors to the driver list', async () => {
    const raw = createTestDatabase()
    try {
      const migrator = new Migrator({ db: raw, provider: { getMigrations: async () => migrations } })
      await migrator.migrateTo('0011_board_services')
      const a = await raw.insertInto('board_trucks').values({ carrier: 'Alfa', driver: 'Kierowca  Testowy', phone: '600000001', sort_order: 1 }).returning('id').executeTakeFirstOrThrow()
      const b = await raw.insertInto('board_trucks').values({ carrier: 'Alfa', driver: 'kierowca testowy', phone: '', sort_order: 2 }).returning('id').executeTakeFirstOrThrow()
      await raw.insertInto('board_trucks').values({ carrier: 'Beta', driver: '', sort_order: 3 }).execute()
      await migrateToLatest(raw)
      expect(await raw.selectFrom('board_drivers').select(['name', 'phone', 'carrier']).execute()).toEqual([{ name: 'Kierowca Testowy', phone: '600000001', carrier: 'Alfa' }])
      const changes = await raw.selectFrom('board_driver_changes').select(['truck_id', 'day']).orderBy('truck_id').execute()
      expect(changes).toEqual([
        { truck_id: a.id, day: '2000-01-01' },
        { truck_id: b.id, day: '2000-01-01' },
      ])
    } finally {
      await raw.destroy()
    }
  })
})

describe('paczka 12.10.2026 — hours, totals, route header, "zniknęło"', () => {
  const truckId = async (plate: string) => (await board.fleet()).find(t => t.currentPlate === plate)!.id

  it('reads hour windows from the export; hours appearing for the first time are not a change; a file without the columns keeps them', async () => {
    const rows: Row[] = [
      { no: '79-1-26', from: 'Łódź', ld: '2026-09-21', to: 'Vecsés', ud: '2026-09-22', rev: 1400, cost: 1150, sub: 'AA1001A', trailer: 'TR100', lh: '16:00 — —', uh: '— — 16:00' },
      { no: '79-2-26', from: 'Vecsés', ld: '2026-09-22', to: 'Flughafen Wien', ud: '2026-09-22', rev: 500, cost: 400, sub: 'AA1001A', trailer: 'TR100', lh: '17:00 — —', uh: '23:00 — —' },
    ]
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily') // no hour columns yet
    const second = await board.importFile(await xlsx(rows, HOURS_HEADERS), 'b.xlsx', 'daily')
    expect(second.updated).toEqual([])
    const bars = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1001A')!.bars
    expect(bars.map(b => [b.orderNo, b.startTime, b.endTime])).toEqual([
      ['79-1-26', '16:00', '16:00'],
      ['79-2-26', '17:00', '23:00'],
    ])
    await board.importFile(await xlsx(rows), 'c.xlsx', 'daily')
    const d = await board.orderDetails('79-2-26')
    expect([d.order.loadTime, d.order.unloadTime]).toEqual(['17:00', '23:00'])
    const changed = await board.importFile(await xlsx([rows[0]!, { ...rows[1]!, uh: '22:00 — 22:00' }], HOURS_HEADERS), 'd.xlsx', 'daily')
    expect(changed.updated).toEqual([{ orderNo: '79-2-26', changes: [{ field: 'unload_time', from: '23:00', to: '22:00' }] }])
  })

  it('manual loading/unloading: date and hour or just the hour; refused when unreadable or out of order; the application wins only when it changes it', async () => {
    const row: Row = { no: '79-3-26', from: 'Warszawa', ld: '2026-09-21', to: 'Vecsés', ud: '2026-09-23', rev: 1400, cost: 1150, sub: 'AA1001A', trailer: 'TR100', lh: '08:00 — 09:00', uh: '— — 16:00' }
    await board.importFile(await xlsx([row], HOURS_HEADERS), 'a.xlsx', 'daily')
    await board.setOverride('79-3-26', 'unload_at', '22.09 22:00')
    let d = await board.orderDetails('79-3-26')
    expect([d.order.unloadDate, d.order.unloadTime, d.order.unloadAtManual]).toEqual(['2026-09-22', '22:00', true])
    expect(d.overrides.find(o => o.field === 'unload_at')?.display).toBe('22.09 22:00')
    await board.setOverride('79-3-26', 'unload_at', '12:00')
    d = await board.orderDetails('79-3-26')
    expect([d.order.unloadDate, d.order.unloadTime]).toEqual(['2026-09-22', '12:00'])
    await expect(board.setOverride('79-3-26', 'unload_at', 'jutro')).rejects.toMatchObject({ code: 'BAD_AT' })
    await expect(board.setOverride('79-3-26', 'unload_at', '20.09 10:00')).rejects.toMatchObject({ code: 'AT_ORDER' })
    const bar = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1001A')!.bars[0]!
    expect([bar.endDate, bar.endTime]).toEqual(['2026-09-22', '12:00'])

    // Same values from the application: the correction stays.
    await board.importFile(await xlsx([row], HOURS_HEADERS), 'b.xlsx', 'daily')
    expect((await board.orderDetails('79-3-26')).order.unloadAtManual).toBe(true)
    // The application changes the unloading hour: it wins and the review says so.
    await board.importFile(await xlsx([{ ...row, uh: '— — 18:00' }], HOURS_HEADERS), 'c.xlsx', 'daily')
    d = await board.orderDetails('79-3-26')
    expect([d.order.unloadDate, d.order.unloadTime, d.order.unloadAtManual]).toEqual(['2026-09-23', '18:00', false])
    expect((await issuesOf('OVERRIDE_SUPERSEDED'))[0]?.message).toContain('(rozładunek)')
  })

  it('a correction made before the file had hours survives the hours arriving; a corrected loading day moves the order to that week', async () => {
    const row: Row = { no: '79-4-26', from: 'Warszawa', ld: '2026-09-28', to: 'Vecsés', ud: '2026-09-29', rev: 1400, cost: 1150, sub: 'AA1001A', trailer: 'TR100' }
    await board.importFile(await xlsx([row]), 'a.xlsx', 'daily')
    await board.setOverride('79-4-26', 'load_at', '27.09 20:00')
    await board.importFile(await xlsx([{ ...row, lh: '06:00 — —' }], HOURS_HEADERS), 'b.xlsx', 'daily')
    const d = await board.orderDetails('79-4-26')
    expect([d.order.loadDate, d.order.loadTime, d.order.loadAtManual]).toEqual(['2026-09-27', '20:00', true])
    const before = await board.weekView('2026-09-21')
    expect(before.kpis.orders).toBe(1)
    expect(before.trucks.find(t => t.plate === 'AA1001A')!.totals.revenue).toBe(1400)
    expect((await board.weekView('2026-09-28')).kpis.orders).toBe(0)
  })

  it('truck totals: our revenue and the carrier revenue (amounts without ferries), on the board and the set page', async () => {
    await board.importFile(
      await xlsx([{ no: '79-5-26', from: 'Warszawa', ld: '2026-09-21', to: 'Vecsés', ud: '2026-09-22', rev: 2000, cost: 1500, sub: 'AA1001A', trailer: 'TR100', notes: 'PROM 300' }]),
      'a.xlsx',
      'daily',
    )
    const t = (await board.weekView('2026-09-21')).trucks.find(x => x.plate === 'AA1001A')!.totals
    expect([t.revenue, t.carrier, t.cost, t.margin]).toEqual([2000, 1500, 1800, 200])
    const page = await board.truckView(await truckId('AA1001A'), '2026-09-21', '2026-09-21')
    expect(page.totals.carrier).toBe(1500)
    expect(page.orders[0]).toMatchObject({ amount: 1800, carrierAmount: 1500 })
  })

  it('order panel route: every place but the last unloading before the arrow', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-6-26', from: 'Warszawa', ld: '2026-09-21', to: 'Pyrzowice + Vecsés', ud: '2026-09-22', rev: 1400, cost: 1300, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-7-26', from: 'Gdańsk + Łódź', ld: '2026-09-23', to: 'Ożarowice', ud: '2026-09-24', rev: 2120, cost: 1620, sub: 'AA1002A', trailer: 'TR200' },
      ]),
      'a.xlsx',
      'daily',
    )
    expect((await board.orderDetails('79-6-26')).order.route).toBe('Warszawa + Katowice (Pyrzowice) → Budapeszt (Vecsés)')
    expect((await board.orderDetails('79-7-26')).order.route).toBe('Gdańsk + Łódź → Katowice (Pyrzowice)')
    // The bar keeps the short title with the destination first.
    const bar = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1001A')!.bars[0]!
    expect(bar.title).toBe('Warszawa → Budapeszt (Vecsés) (przez Katowice (Pyrzowice))')
  })

  it('"zniknęło" is told only in the order panel, not on the bar', async () => {
    const a: Row = { no: '79-8-26', from: 'Warszawa', ld: '2026-09-21', to: 'Vecsés', ud: '2026-09-22', rev: 1400, cost: 1300, sub: 'AA1001A', trailer: 'TR100' }
    const b: Row = { no: '79-9-26', from: 'Vecsés', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1400, cost: 1300, sub: 'AA1001A', trailer: 'TR100' }
    await board.importFile(await xlsx([a, b]), 'a.xlsx', 'daily')
    await board.importFile(await xlsx([b, { ...a, no: '79-10-26', ld: '2026-09-21' }]), 'b.xlsx', 'daily')
    const bar = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1001A')!.bars.find(x => x.orderNo === '79-8-26')!
    expect(bar.missing).toBe(true)
    expect(bar.noteLines.join(' ')).not.toContain('Zniknęło')
    expect((await board.orderDetails('79-8-26')).order.missing).toBe(true)
  })
})

describe('preliminary orders (zlecenia wstępne, 12.10.2026)', () => {
  const truckId = async (plate: string) => (await board.fleet()).find(t => t.currentPlate === plate)!.id
  const draft = async (plate: string, over: Partial<Parameters<BoardService['createDraft']>[0]> = {}) =>
    board.createDraft({
      truckId: await truckId(plate),
      loadPlaces: 'Warszawa',
      loadDate: '2026-09-28',
      unloadPlaces: 'Wilno',
      unloadDate: '2026-09-29',
      client: 'Klient Testowy',
      rev: '2 000 €',
      cost: '1600',
      ...over,
    })

  it('is on the board and in the totals like an order; without both rates only its km count', async () => {
    expect(await draft('AA1001A', { note: 'klient potwierdzi jutro' })).toBe('W-1')
    const week = await board.weekView('2026-09-28')
    const truck = week.trucks.find(t => t.plate === 'AA1001A')!
    expect(truck.bars[0]).toMatchObject({ orderNo: 'W-1', draft: true, title: 'Warszawa → Wilno' })
    expect([truck.totals.revenue, truck.totals.carrier, truck.totals.margin]).toEqual([2000, 1600, 400])
    expect([week.kpis.orders, week.kpis.drafts, week.kpis.revenue]).toEqual([1, 1, 2000])

    expect(await draft('AA1002A', { cost: '' })).toBe('W-2')
    const d = await board.orderDetails('W-2')
    expect([d.order.draftNoMoney, d.order.margin, d.order.draft?.rev]).toEqual([true, null, 2000])
    const again = await board.weekView('2026-09-28')
    expect(again.kpis.revenue).toBe(2000)
    expect(again.trucks.find(t => t.plate === 'AA1002A')!.totals.revenue).toBe(0)
    expect(await issuesOf('MISSING_TRAILER')).toEqual([])
    expect((await board.orderDetails('W-1')).notes.map(n => n.text)).toEqual(['klient potwierdzi jutro'])
  })

  it('checks the form and logs edits', async () => {
    await expect(draft('AA1001A', { loadPlaces: ' ' })).rejects.toMatchObject({ code: 'EMPTY_PLACE' })
    await expect(draft('AA1001A', { unloadDate: '2026-09-27' })).rejects.toMatchObject({ code: 'AT_ORDER' })
    await expect(draft('AA1001A', { loadTime: '25:00' })).rejects.toMatchObject({ code: 'BAD_TIME' })
    await expect(draft('AA1001A', { rev: '2000 zł' })).rejects.toMatchObject({ code: 'BAD_NUMBER' })
    const no = await draft('AA1001A')
    await board.updateDraft(no, { cost: '1500', unloadTime: '10:00' })
    const d = await board.orderDetails(no)
    expect([d.order.draft?.cost, d.order.unloadTime]).toEqual([1500, '10:00'])
    expect(d.history.map(h => h.text).join('\n')).toMatch(/zmiana zlecenia wstępnego — test: .*kwota dla przewoźnika 1600 → 1500/)
  })

  it('the imported order on the same truck, loading within a day, replaces it; notes move to the order', async () => {
    const no = await draft('AA1001A', { note: 'awizacja 2 h wcześniej' })
    await draft('BB2001B') // other truck: stays
    const summary = await board.importFile(
      await xlsx([{ no: '79-60-26', from: 'Warszawa', ld: '2026-09-29', to: 'Vilnius', ud: '2026-09-30', rev: 2100, cost: 1600, sub: 'AA1001A', trailer: 'TR100' }]),
      'a.xlsx',
      'daily',
    )
    expect(summary.replacedDrafts).toEqual([{ draftNo: no, orderNo: '79-60-26' }])
    await expect(board.orderDetails(no)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
    const d = await board.orderDetails('79-60-26')
    expect(d.notes.map(n => n.text)).toEqual(['awizacja 2 h wcześniej'])
    expect(d.history.map(h => h.text)).toContain('zastąpiło zlecenie wstępne W-1 (Warszawa → Wilno, 28.09)')
    expect((await board.orderDetails('W-2')).order.draft).not.toBeNull()
    expect(summary.disappeared).toEqual([])
  })

  it('two possible orders: the same loading place decides, otherwise the review asks', async () => {
    const a = await draft('AA1001A', { loadPlaces: 'Wien', loadDate: '2026-09-28' })
    const summary = await board.importFile(
      await xlsx([
        { no: '79-61-26', from: 'Warszawa', ld: '2026-09-28', to: 'Vilnius', ud: '2026-09-29', rev: 2100, cost: 1600, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-62-26', from: 'Wien', ld: '2026-09-29', to: 'Vilnius', ud: '2026-09-30', rev: 2100, cost: 1600, sub: 'AA1001A', trailer: 'TR100' },
      ]),
      'a.xlsx',
      'daily',
    )
    expect(summary.replacedDrafts).toEqual([{ draftNo: a, orderNo: '79-62-26' }])

    const b = await draft('AA1002A', { loadPlaces: 'Gdańsk', loadDate: '2026-09-28' })
    const second = await board.importFile(
      await xlsx([
        { no: '79-63-26', from: 'Warszawa', ld: '2026-09-28', to: 'Vilnius', ud: '2026-09-29', rev: 2100, cost: 1600, sub: 'AA1002A', trailer: 'TR200' },
        { no: '79-64-26', from: 'Wien', ld: '2026-09-29', to: 'Vilnius', ud: '2026-09-30', rev: 2100, cost: 1600, sub: 'AA1002A', trailer: 'TR200' },
      ]),
      'b.xlsx',
      'daily',
    )
    expect(second.draftQuestions).toEqual([b])
    const [question] = await issuesOf('DRAFT_MATCH')
    expect(question?.details['candidates']).toEqual(['79-63-26', '79-64-26'])
    await expect(board.resolveIssue(question!.id, 'replace', { orderNo: '79-1-26' })).rejects.toMatchObject({ code: 'BAD_ORDER' })
    await board.resolveIssue(question!.id, 'replace', { orderNo: '79-64-26' })
    await expect(board.orderDetails(b)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
    expect(await issuesOf('DRAFT_MATCH')).toEqual([])
  })

  it('past its unloading without an order it goes to review (keep or delete); imports never call it "zniknęło"', async () => {
    const no = await draft('AA1001A', { loadDate: '2026-09-24', unloadDate: '2026-09-25' })
    await board.importFile(
      await xlsx([{ no: '79-70-26', from: 'Warszawa', ld: '2026-09-21', to: 'Vilnius', ud: '2026-09-22', rev: 2100, cost: 1600, sub: 'AA1002A', trailer: 'TR200' }, { no: '79-71-26', from: 'Warszawa', ld: '2026-09-27', to: 'Vilnius', ud: '2026-09-28', rev: 2100, cost: 1600, sub: 'AA1002A', trailer: 'TR200' }]),
      'a.xlsx',
      'daily',
    )
    expect(await issuesOf('DISAPPEARED')).toEqual([])
    const [stale] = await issuesOf('DRAFT_STALE')
    expect(stale?.ref).toBe(no)
    await board.resolveIssue(stale!.id, 'dismiss', {})
    expect(await issuesOf('DRAFT_STALE')).toEqual([])
    const other = await draft('AA1002A', { loadDate: '2026-09-23', unloadDate: '2026-09-24' })
    const [second] = await issuesOf('DRAFT_STALE')
    await board.resolveIssue(second!.id, 'delete', {})
    await expect(board.orderDetails(other)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })
})

describe('day events on the board (12.10.2026 bug: place hidden, no edit, km moved by a note)', () => {
  it('a note keeps its place as information only; only "Pozycja auta" moves the empty run; events can be corrected and deleted', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-90-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-91-26', from: 'Wien', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR100' },
      ]),
      'a.xlsx',
      'daily',
    )
    const truck = (await board.fleet()).find(t => t.currentPlate === 'AA1001A')!
    await board.addTruckEvent({ truckId: truck.id, day: '2026-09-22', kind: 'note', text: 'TEST', place: 'POZ' })
    expect((await board.orderDetails('79-91-26')).legs[0]?.kmEmptyFrom).toBe('Budapeszt (Vecsés)')

    const event = (await board.weekView('2026-09-21')).trucks.find(t => t.id === truck.id)!.events.find(e => e.text === 'TEST')!
    expect(event).toMatchObject({ kind: 'note', place: 'POZ', placeName: 'Poznań', createdBy: 'test', auto: false })

    await board.updateTruckEvent(event.id!, { kind: 'position', place: 'Bratislava' })
    expect((await board.orderDetails('79-91-26')).legs[0]?.kmEmptyFrom).toBe('Bratysława')
    await expect(board.updateTruckEvent(event.id!, { place: 'Nibylandia' })).rejects.toMatchObject({ code: 'PLACE_UNKNOWN' })
    await expect(board.updateTruckEvent(event.id!, { kind: 'service' })).rejects.toMatchObject({ code: 'USE_SERVICE_FORM' })
    await board.updateTruckEvent(event.id!, { place: '', text: 'stoi na bazie', day: '2026-09-21' })
    const changed = (await board.weekView('2026-09-21')).trucks.find(t => t.id === truck.id)!.events.find(e => e.id === event.id)!
    expect(changed).toMatchObject({ day: '2026-09-21', text: 'stoi na bazie', place: null })
    expect((await board.orderDetails('79-91-26')).legs[0]?.kmEmptyFrom).toBe('Budapeszt (Vecsés)')

    await board.deleteNote(event.id!)
    expect((await board.weekView('2026-09-21')).trucks.find(t => t.id === truck.id)!.events.some(e => e.id === event.id)).toBe(false)
    await expect(board.updateTruckEvent(event.id!, { text: 'x' })).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' })
  })
})

describe('paczka 26.10.2026 — withdrawn tractor, "Km razem", manual PRZ label, route continuity, partial exports', () => {
  const truckId = async (plate: string) => (await board.fleet()).find(t => t.currentPlate === plate || t.plates.some(p => p.plate === plate))!.id

  it('a withdrawn tractor stays in the weeks up to its last day; its driver moves on; a later order asks to bring it back', async () => {
    const aa2 = await truckId('AA1002A')
    const bb = await truckId('BB2001B')
    await expect(board.retireTruck(aa2, '2025-12-31')).rejects.toMatchObject({ code: 'BAD_DATE' })
    const res = await board.retireTruck(aa2, '2026-09-22', { moveDriverTo: bb })
    expect(res).toEqual({ plate: 'AA1002A', driverMovedTo: 'BB2001B' })
    await expect(board.retireTruck(aa2, '2026-09-23')).rejects.toMatchObject({ code: 'ALREADY_RETIRED' })
    expect((await board.fleet()).find(t => t.id === aa2)?.retiredOn).toBe('2026-09-22')
    // The pasted fleet list does not miss it, and names it when it is listed again.
    expect((await board.syncFleetList('Alfa:\nCiągniki: AA1001A\nNaczepy: TR100\nBeta:\nCiągniki: BB2001B\nNaczepy: TR200', false)).warnings).toEqual([])
    expect((await board.syncFleetList('Alfa:\nCiągniki: AA1001A, AA1002A\nNaczepy: TR100\nBeta:\nCiągniki: BB2001B\nNaczepy: TR200', false)).warnings).toEqual([
      'AA1002A jest na liście, ale jest wycofany z działu (ostatni dzień 22.09.2026). Jeśli wrócił: Ciągniki → „Wycofane z działu” → Przywróć.',
    ])

    await board.importFile(
      await xlsx([
        { no: '79-6-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-22', rev: 1000, cost: 900, sub: 'AA1002A', trailer: 'TR200' },
        { no: '79-7-26', from: 'Budapest', ld: '2026-09-24', to: 'Warszawa', ud: '2026-09-25', rev: 1000, cost: 900, sub: 'AA1002A', trailer: 'TR200' },
      ]),
      'a.xlsx',
      'daily',
    )
    const week = await board.weekView('2026-09-21')
    expect(week.trucks.find(t => t.id === aa2)?.bars.map(b => b.orderNo)).toEqual(['79-6-26'])
    expect((await board.weekView('2026-09-28')).trucks.some(t => t.id === aa2)).toBe(false)
    const nextWeek = await board.weekView('2026-09-28')
    expect(nextWeek.trucks.find(t => t.id === bb)?.driver).toBe('Ewa L.')

    const [issue] = await issuesOf('NEW_TRUCK')
    expect(issue).toMatchObject({ ref: 'AA1002A' })
    expect(issue!.message).toMatch(/wycofany z działu \(ostatni dzień 22\.09\)/)
    expect(issue!.details['retiredTruckId']).toBe(aa2)

    await board.resolveIssue(issue!.id, 'restore', {})
    expect((await board.fleet()).find(t => t.id === aa2)?.retiredOn).toBeNull()
    expect(await issuesOf('NEW_TRUCK')).toEqual([])
    // Its later orders come with the next import (the file of the import above was not kept).
    await board.importFile(
      await xlsx([{ no: '79-7-26', from: 'Budapest', ld: '2026-09-24', to: 'Warszawa', ud: '2026-09-25', rev: 1000, cost: 900, sub: 'AA1002A', trailer: 'TR200' }]),
      'b.xlsx',
      'daily',
    )
    expect((await board.weekView('2026-09-21')).trucks.find(t => t.id === aa2)?.bars.map(b => b.orderNo)).toEqual(['79-6-26', '79-7-26'])
  })

  it('adding the plate of a "new tractor" in Flota closes its review item', async () => {
    await board.importFile(
      await xlsx([{ no: '79-5-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1000, cost: 900, sub: 'NEW123', carrier: 'Przewoźnik Alfa' }]),
      'a.xlsx',
      'daily',
    )
    expect((await issuesOf('NEW_TRUCK')).map(i => i.ref)).toEqual(['NEW123'])
    await board.addTruckPlate(await truckId('AA1002A'), 'NEW123', '2026-09-20')
    expect(await issuesOf('NEW_TRUCK')).toEqual([])
  })

  it('"Km razem" replaces all km of the truck on the order: the empty run stays as computed, the rest is loaded; it wins over the older pair', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-90-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-91-26', from: 'Wien', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR100' },
      ]),
      'a.xlsx',
      'daily',
    )
    const before = (await board.orderDetails('79-91-26')).legs[0]!
    expect(before.kmManual).toBe(false)
    const empty = before.kmEmpty!
    expect(empty).toBeGreaterThan(100)

    await board.setOverride('79-91-26', 'km_loaded', '700')
    await board.setOverride('79-91-26', 'km_total', '1250 km')
    let leg = (await board.orderDetails('79-91-26')).legs[0]!
    expect([leg.kmEmpty, leg.kmLoaded, leg.kmManual, leg.kmEstimated]).toEqual([empty, 1250 - empty, true, false])
    const row = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1001A')!
    expect(row.bars.find(b => b.orderNo === '79-91-26')).toMatchObject({ kmLoaded: 1250 - empty, kmEmpty: empty })

    await board.setOverride('79-91-26', 'km_total', '100')
    leg = (await board.orderDetails('79-91-26')).legs[0]!
    expect([leg.kmEmpty, leg.kmLoaded]).toEqual([100, 0])
    await expect(board.setOverride('79-91-26', 'km_total', 'dużo')).rejects.toMatchObject({ code: 'BAD_NUMBER' })

    await board.clearOverride('79-91-26', 'km_total')
    leg = (await board.orderDetails('79-91-26')).legs[0]!
    expect([leg.kmLoaded, leg.kmManual]).toEqual([700, true]) // the older correction still counts
  })

  it('a PRZ entry typed on the board is labelled as a manual correction, with who and when', async () => {
    await board.importFile(
      await xlsx([{ no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 2000, cost: 1250, sub: 'AA1001A', trailer: 'TR100' }]),
      'a.xlsx',
      'daily',
    )
    expect((await board.orderDetails('79-1-26')).order.przManual).toBeNull()
    await board.setOverride('79-1-26', 'prz', 'PRZ BRATISLAVA 21.09 AA1001A>BB2001B 700/600')
    const d = await board.orderDetails('79-1-26')
    expect(d.order.prz).toMatchObject({ from: 'AA1001A', to: 'BB2001B' })
    expect(d.order.przManual).toMatchObject({ createdBy: 'test' })
  })

  it('"Czy była przepinka?": two orders of a truck too far apart for the time between them', async () => {
    const rows: Row[] = [
      { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100', lh: '08:00 — —', uh: '— — 13:00' },
      { no: '79-2-26', from: 'Warszawa', ld: '2026-09-22', to: 'Wilno', ud: '2026-09-23', rev: 1500, cost: 1200, sub: 'AA1001A', trailer: 'TR100', lh: '16:00 — —', uh: '— — 12:00' },
    ]
    await board.importFile(await xlsx(rows, HOURS_HEADERS), 'a.xlsx', 'daily')
    const [gap] = await issuesOf('ROUTE_GAP')
    expect(gap).toMatchObject({ ref: '79-2-26' })
    expect(gap!.details['orders']).toEqual(['79-1-26', '79-2-26'])
    expect(gap!.message).toMatch(/^Czy była przepinka\? AA1001A: rozładunek 79-1-26 — Budapeszt \(Vecsés\) 22\.09 13:00, załadunek 79-2-26 — Warszawa 22\.09 16:00: ok\. \d+ km pustych w 3 h\./)

    // The truck really handed the first order over in Bratislava: entering the relay clears it.
    await board.setOverride('79-1-26', 'prz', 'PRZ BRATISLAVA 21.09 AA1001A>BB2001B 700/600')
    expect(await issuesOf('ROUTE_GAP')).toEqual([])
    await board.clearOverride('79-1-26', 'prz')
    expect(await issuesOf('ROUTE_GAP')).toHaveLength(1)

    // A wrong hour corrected on the board clears it too.
    await board.setOverride('79-2-26', 'load_at', '23.09 08:00')
    expect(await issuesOf('ROUTE_GAP')).toEqual([])
  })

  it('without hours: same day and a long empty run is suspicious; a short one is not', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-2-26', from: 'Warszawa', ld: '2026-09-22', to: 'Wilno', ud: '2026-09-23', rev: 1500, cost: 1200, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-3-26', from: 'Warszawa', ld: '2026-09-21', to: 'Łódź', ud: '2026-09-21', rev: 500, cost: 400, sub: 'AA1002A', trailer: 'TR200' },
        { no: '79-4-26', from: 'Warszawa', ld: '2026-09-21', to: 'Poznań', ud: '2026-09-22', rev: 900, cost: 700, sub: 'AA1002A', trailer: 'TR200' },
      ]),
      'a.xlsx',
      'daily',
    )
    const gaps = await issuesOf('ROUTE_GAP')
    expect(gaps.map(g => g.ref)).toEqual(['79-2-26'])
    expect(gaps[0]!.message).toMatch(/km pustych tego samego dnia/)
    await board.resolveIssue(gaps[0]!.id, 'dismiss', {})
    await board.refreshIssues()
    expect(await issuesOf('ROUTE_GAP')).toEqual([])
  })

  it('a small export (a few last-minute orders) adds and updates without flagging the rest of its days', async () => {
    const full: Row[] = [
      { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
      { no: '79-2-26', from: 'Warszawa', ld: '2026-09-22', to: 'Budapest', ud: '2026-09-23', rev: 1400, cost: 1200, sub: 'AA1002A', trailer: 'TR200' },
      { no: '79-3-26', from: 'Warszawa', ld: '2026-09-23', to: 'Budapest', ud: '2026-09-24', rev: 1400, cost: 1200, sub: 'BB2001B', carrier: 'Beta Trans', trailer: 'TR960PE' },
      { no: '79-4-26', from: 'Budapest', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1300, cost: 1100, sub: 'AA1001A', trailer: 'TR100' },
    ]
    await board.importFile(await xlsx(full), 'pelny.xlsx', 'daily')

    now = '2026-09-27T19:00:00Z'
    const small = await board.importFile(
      await xlsx([
        { ...full[1]!, cost: 1150 },
        { no: '79-5-26', from: 'Budapest', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1250, cost: 1050, sub: 'AA1002A', trailer: 'TR200' },
      ]),
      'maly.xlsx',
      'daily',
    )
    expect(small.created).toEqual(['79-5-26'])
    expect(small.updated.map(u => u.orderNo)).toEqual(['79-2-26'])
    expect(small.disappeared).toEqual([])
    expect(small.partial).toEqual({ found: 2, missing: 2 })
    expect(await issuesOf('DISAPPEARED')).toEqual([])
    expect((await board.imports()).map(i => i.partial)).toEqual([1, 0])
    const week = await board.weekView('2026-09-21')
    expect(week.lastImport).toMatchObject({ filename: 'pelny.xlsx', supplement: { filename: 'maly.xlsx', orders: 2 } })

    // A full export still finds an order that is really gone.
    const again = await board.importFile(await xlsx([full[0]!, full[1]!, full[3]!, { no: '79-5-26', from: 'Budapest', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1250, cost: 1050, sub: 'AA1002A', trailer: 'TR200' }]), 'pelny2.xlsx', 'daily')
    expect(again.partial).toBeUndefined()
    expect(again.disappeared).toEqual(['79-3-26'])
    expect((await board.weekView('2026-09-21')).lastImport).toMatchObject({ filename: 'pelny2.xlsx', supplement: null })
  })
})

describe('migration 0014', () => {
  it('marks earlier partial imports and takes back their "zniknęło", unless a later full export lacked the order too', async () => {
    const raw = createTestDatabase()
    try {
      const migrator = new Migrator({ db: raw, provider: { getMigrations: async () => migrations } })
      await migrator.migrateTo('0013_board_hours_drafts')
      const imp = async (rows: number, from: string, to: string) =>
        (
          await raw
            .insertInto('board_imports')
            .values({ filename: 'x.xlsx', imported_at: '2026-10-26T10:00:00Z', mode: 'daily', rows_total: rows, rows_in_scope: rows, range_from: from, range_to: to, summary: JSON.stringify({ disappeared: ['79-1-26'] }) })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id
      const full = await imp(5, '2026-10-19', '2026-10-25')
      const small = await imp(1, '2026-10-19', '2026-10-23')
      const order = (no: string, ld: string, last: number, missing: number | null) =>
        raw
          .insertInto('board_orders')
          .values({
            order_no: no, client: 'K', client_ref: '', status_client: 'Z', status_sped: 'Z', carrier: 'Alfa', sub_plate: 'AA1001A', own_plate: '', trailer_raw: '',
            load_places: 'Warszawa', load_country: '', load_date: ld, unload_places: 'Budapest', unload_country: '', unload_date: ld,
            rev_eur: 1, cost_eur: 1, notes_app: '', first_import_id: full, last_import_id: last, missing_since_import_id: missing,
            created_at: '2026-10-26T10:00:00Z', updated_at: '2026-10-26T10:00:00Z',
          })
          .execute()
      for (const [no, ld] of [['79-1-26', '2026-10-19'], ['79-2-26', '2026-10-20'], ['79-3-26', '2026-10-21'], ['79-4-26', '2026-10-22']] as const) await order(no, ld, full, small)
      await order('79-5-26', '2026-10-23', small, null)
      const later = await imp(4, '2026-10-19', '2026-10-25') // full: 79-1-26 is not in it
      await raw.updateTable('board_orders').set({ last_import_id: later }).where('order_no', 'in', ['79-2-26', '79-3-26', '79-4-26', '79-5-26']).execute()
      // …and 79-4-26 was flagged by the small file; a later full one had it (last_import_id = later).
      for (const no of ['79-1-26', '79-2-26', '79-3-26', '79-4-26']) {
        await raw
          .insertInto('board_issues')
          .values({ key: `DISAPPEARED:${no}`, kind: 'DISAPPEARED', ref: no, message: 'x', details: '{}', fingerprint: String(small), status: 'open', created_at: 'x', updated_at: 'x' })
          .execute()
      }
      await raw.insertInto('board_trucks').values({ carrier: 'Alfa', sort_order: 1 }).execute()
      await raw.insertInto('board_truck_plates').values({ truck_id: 1, plate: 'NEW123', valid_from: '2026-10-20', valid_to: null }).execute()
      await raw
        .insertInto('board_issues')
        .values({ key: 'NEW_TRUCK:NEW123', kind: 'NEW_TRUCK', ref: 'NEW123', message: 'x', details: '{}', fingerprint: 'NEW123', status: 'open', created_at: 'x', updated_at: 'x' })
        .execute()

      await migrateToLatest(raw)
      expect(await raw.selectFrom('board_imports').select(['id', 'partial']).orderBy('id').execute()).toEqual([
        { id: full, partial: 0 },
        { id: small, partial: 1 },
        { id: later, partial: 0 },
      ])
      const flags = await raw.selectFrom('board_orders').select(['order_no', 'missing_since_import_id']).orderBy('order_no').execute()
      expect(flags).toEqual([
        { order_no: '79-1-26', missing_since_import_id: later },
        { order_no: '79-2-26', missing_since_import_id: null },
        { order_no: '79-3-26', missing_since_import_id: null },
        { order_no: '79-4-26', missing_since_import_id: null },
        { order_no: '79-5-26', missing_since_import_id: null },
      ])
      const open = await raw.selectFrom('board_issues').select(['ref', 'status']).where('status', '=', 'open').orderBy('ref').execute()
      expect(open).toEqual([{ ref: '79-1-26', status: 'open' }])
      // The "Ostatni import" card of the partial file: no "zniknęło", told as partial.
      const summary = JSON.parse((await raw.selectFrom('board_imports').select('summary').where('id', '=', small).executeTakeFirstOrThrow()).summary)
      expect(summary).toMatchObject({ disappeared: [], partial: { found: 1, missing: 4 } })
    } finally {
      await raw.destroy()
    }
  })
})

describe('27.10.2026 — a relay with a mistyped plate must not make an order vanish', () => {
  // AA1001A carries 79-1-26 (fleet); KN5692K is an own-fleet truck (known from its own order).
  const rows: Row[] = [
    { no: '79-1-26', from: 'Wien', ld: '2026-09-21', to: 'Wilno', ud: '2026-09-22', rev: 3120, cost: 1000, sub: 'AA1001A', trailer: 'TR100' },
    { no: '79-3-26', from: 'Warszawa', ld: '2026-09-22', to: 'Praha 6 - Ruzyně', ud: '2026-09-23', rev: 900, cost: null, own: 'KN5692K' },
  ]
  beforeEach(async () => {
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily')
  })

  it('board entry: a plate one slip away from a known one is refused with the suggestion', async () => {
    await expect(board.setOverride('79-1-26', 'prz', 'PRZ WAW 22.09 AA1010A>KN5692K 1420/1700')).rejects.toMatchObject({
      code: 'PRZ_PLATE_TYPO',
      message: expect.stringContaining('Czy chodziło o AA1001A?'),
    })
    await expect(board.setOverride('79-1-26', 'prz', 'PRZ WAW 22.09 AA1001A>KN5629K 1420/1700')).rejects.toMatchObject({
      code: 'PRZ_PLATE_TYPO',
      message: expect.stringContaining('KN5692K'),
    })
    expect((await board.orderDetails('79-1-26')).order.prz).toBeNull() // nothing stored
  })

  it('board entry: no fleet truck in the entry is refused — the order would leave the board', async () => {
    await expect(board.setOverride('79-1-26', 'prz', 'PRZ WAW 22.09 XY77777>KN5692K 1420/1700')).rejects.toMatchObject({
      code: 'PRZ_NO_FLEET_TRUCK',
      message: expect.stringContaining('auto z eksportu: AA1001A'),
    })
  })

  it('board entry: unreadable text is refused with the pattern', async () => {
    await expect(board.setOverride('79-1-26', 'prz', 'PRZ WAW 22.09 AA1001A>KN5692K')).rejects.toMatchObject({ code: 'BAD_PRZ' })
  })

  it('board entry: a correct relay to the own fleet is saved; the fleet leg stays on the board', async () => {
    await board.setOverride('79-1-26', 'prz', 'PRZ WAW 22.09 AA1001A>KN5692K 1420/1700')
    const d = await board.orderDetails('79-1-26')
    expect(d.legs.map(l => [l.plate, l.kind])).toEqual([
      ['AA1001A', 'fleet'],
      ['KN5692K', 'own'],
    ])
    const week = await board.weekView('2026-09-21')
    expect(week.trucks.find(t => t.plate === 'AA1001A')!.bars.map(b => b.orderNo)).toContain('79-1-26')
  })

  it('board entry: a third-party truck with no similar plate is accepted, with the "Literówka?" item', async () => {
    await board.setOverride('79-1-26', 'prz', 'PRZ WAW 22.09 AA1001A>XY77777 1000/1700')
    const [item] = await issuesOf('PRZ_TRUCK_UNKNOWN')
    expect(item!.message).toBe('Auto XY77777 z wpisu PRZ nie jest ani w Twojej flocie, ani we flocie własnej. Literówka?')
  })

  it('an entry already stored with the typo (or one from the application) shows up in review instead of vanishing', async () => {
    // As on the office PC on 27.10: stored before this check existed.
    await db
      .insertInto('board_overrides')
      .values({ order_no: '79-1-26', field: 'prz', value: 'PRZ WAW 22.09 AA1010A>KN5692K 1420/1700', app_value: '', created_by: 'test', created_at: now })
      .execute()
    await board.refreshIssues()

    const week = await board.weekView('2026-09-21')
    expect(week.trucks.flatMap(t => t.bars.map(b => b.orderNo))).not.toContain('79-1-26')
    const [typo] = await issuesOf('PRZ_TRUCK_UNKNOWN')
    expect(typo).toMatchObject({ ref: '79-1-26' })
    expect(typo!.message).toContain('Literówka? Podobny numer: AA1001A.')
    expect(typo!.message).toContain('Zlecenia nie ma teraz na tablicy')
    const [sub] = await issuesOf('PRZ_SUB_NOT_IN_ENTRY')
    expect(sub!.message).toContain('Auto z eksportu (AA1001A) nie występuje we wpisie PRZ (AA1010A>KN5692K).')

    // Fixed from the order panel (opened from the review item): the order is back, the items close.
    await board.setOverride('79-1-26', 'prz', 'PRZ WAW 22.09 AA1001A>KN5692K 1420/1700')
    expect(await issuesOf('PRZ_TRUCK_UNKNOWN')).toEqual([])
    expect(await issuesOf('PRZ_SUB_NOT_IN_ENTRY')).toEqual([])
    const after = await board.weekView('2026-09-21')
    expect(after.trucks.find(t => t.plate === 'AA1001A')!.bars.map(b => b.orderNo)).toContain('79-1-26')
  })
})

describe('27.10.2026 — "Popraw na …" fixes a mistyped plate in one click', () => {
  it('a board entry: the plate is replaced, the order is back, both items close', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'Wien', ld: '2026-09-21', to: 'Wilno', ud: '2026-09-22', rev: 3120, cost: 1000, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-3-26', from: 'Warszawa', ld: '2026-09-22', to: 'Praha 6 - Ruzyně', ud: '2026-09-23', rev: 900, cost: null, own: 'KN5692K' },
      ]),
      'a.xlsx',
      'daily',
    )
    await db
      .insertInto('board_overrides')
      .values({ order_no: '79-1-26', field: 'prz', value: 'PRZ WAW 22.09 AA1010A>KN5692K 1420/1700', app_value: '', created_by: 'test', created_at: now })
      .execute()
    await board.refreshIssues()
    const [typo] = await issuesOf('PRZ_TRUCK_UNKNOWN')
    expect(typo!.details).toMatchObject({ plate: 'AA1010A', suggestions: ['AA1001A'] })

    await expect(board.resolveIssue(typo!.id, 'fix_plate', { plate: 'BB2001B' })).rejects.toMatchObject({ code: 'BAD_PLATE' })
    await board.resolveIssue(typo!.id, 'fix_plate', { plate: 'AA1001A' })

    const d = await board.orderDetails('79-1-26')
    expect(d.order.prz).toMatchObject({ from: 'AA1001A', to: 'KN5692K', amountFrom: 1420, amountTo: 1700, place: 'WAW' })
    expect(await issuesOf('PRZ_TRUCK_UNKNOWN')).toEqual([])
    expect(await issuesOf('PRZ_SUB_NOT_IN_ENTRY')).toEqual([])
    const week = await board.weekView('2026-09-21')
    expect(week.trucks.find(t => t.plate === 'AA1001A')!.bars.map(b => b.orderNo)).toContain('79-1-26')
  })

  it('an entry from the application notes: the board entry keeps the flight number and the ferry', async () => {
    await board.importFile(
      await xlsx([
        {
          no: '79-1-26', from: 'Wien', ld: '2026-09-21', to: 'Wilno', ud: '2026-09-22', rev: 3620, cost: 1000, sub: 'AA1001A', trailer: 'TR100',
          notes: 'LH6428A-2026-09-21 PRZ WAW 22.09 AA1010A>BB2001B 1000/900 PROM 120',
        },
      ]),
      'a.xlsx',
      'daily',
    )
    const [typo] = await issuesOf('PRZ_TRUCK_UNKNOWN')
    await board.resolveIssue(typo!.id, 'fix_plate', { plate: 'AA1001A' })

    const d = await board.orderDetails('79-1-26')
    expect(d.order.prz).toMatchObject({ from: 'AA1001A', to: 'BB2001B' })
    expect(d.order.ferryCost).toBe(120)
    const stored = await db.selectFrom('board_overrides').select('value').where('order_no', '=', '79-1-26').where('field', '=', 'prz').where('active', '=', 1).executeTakeFirst()
    expect(stored?.value).toBe('LH6428A-2026-09-21 PRZ WAW 22.09 AA1001A>BB2001B 1000/900 PROM 120')
  })
})

describe('27.10.2026 — relay on a multi-drop order splits the route at the swap stop', () => {
  it('WAW → BER + FRA + STR + MUC, PRZ at FRA: the first truck drives via Berlin to Frankfurt, the second Frankfurt → Stuttgart → Munich', async () => {
    await board.importFile(
      await xlsx([
        {
          no: '79-1523-26', from: 'WARSZAWA', ld: '2026-09-21', to: 'Schönefeld + Frankfurt am Main + Stuttgart + Munich Airport', ud: '2026-09-24',
          rev: 3000, cost: 1773, sub: 'AA1001A', trailer: 'TR100', notes: 'PRZ FRA 23.09 AA1001A>BB2001B 1800/800',
        },
      ]),
      'a.xlsx',
      'daily',
    )
    const d = await board.orderDetails('79-1523-26')
    expect(d.legs.map(l => [l.plate, l.stops])).toEqual([
      ['AA1001A', ['Warszawa', 'Berlin', 'Frankfurt']],
      ['BB2001B', ['Frankfurt', 'Stuttgart', 'Munich Airport']],
    ])
  })

  it('a swap place that is not one of the stops still sits between loading and unloading', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-146-26', from: 'Wien', ld: '2026-09-21', to: 'Wilno', ud: '2026-09-22', rev: 3620, cost: 2300, sub: 'AA1001A', trailer: 'TR100', notes: 'PRZ WAW 22.09 AA1001A>AA1002A 1400/900' },
      ]),
      'a.xlsx',
      'daily',
    )
    const d = await board.orderDetails('79-146-26')
    expect(d.legs.map(l => l.stops)).toEqual([
      ['Wiedeń', 'Warszawa'],
      ['Warszawa', 'Wilno'],
    ])
  })
})

describe('paczka 28.10.2026 — skonto, doładunek, trailer change and driver change with an hour, review in the order panel', () => {
  const truckId = async (plate: string) => (await board.fleet()).find(t => t.currentPlate === plate)!.id
  const rowOf = async (plate: string, date = '2026-09-21') => (await board.weekView(date)).trucks.find(t => t.plate === plate)!

  it('the order panel gets its review items with details; "Czy była przepinka?" also in the panel of the first order', async () => {
    const rows: Row[] = [
      { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100', lh: '08:00 — —', uh: '— — 13:00' },
      { no: '79-2-26', from: 'Warszawa', ld: '2026-09-22', to: 'Wilno', ud: '2026-09-23', rev: 1500, cost: 1200, sub: 'AA1001A', trailer: 'TR100', lh: '16:00 — —', uh: '— — 12:00' },
    ]
    await board.importFile(await xlsx(rows, HOURS_HEADERS), 'a.xlsx', 'daily')
    for (const no of ['79-1-26', '79-2-26']) {
      const d = await board.orderDetails(no)
      const gap = d.issues.find(i => i.kind === 'ROUTE_GAP')
      expect(gap?.details['orders']).toEqual(['79-1-26', '79-2-26'])
    }
  })

  it('skonto: the cost is the PRZ amount less 1.5% — no review item, the board counts the amount after it', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 3000, cost: 1576, sub: 'AA1001A', trailer: 'TR100', notes: 'PRZ BRATISLAVA 21.09 AA1001A>BB2001B 1600/800' },
        // Both legs of one carrier on one forwarding order: the sum less skonto.
        { no: '79-2-26', from: 'Warszawa', ld: '2026-09-23', to: 'Budapest', ud: '2026-09-24', rev: 2500, cost: 1970, sub: 'AA1001A', trailer: 'TR100', notes: 'PRZ BRATISLAVA 23.09 AA1001A>AA1002A 1000/1000' },
        // A real difference is still reported.
        { no: '79-3-26', from: 'Warszawa', ld: '2026-09-23', to: 'Budapest', ud: '2026-09-24', rev: 3000, cost: 1000, sub: 'BB2001B', carrier: 'Beta Trans', trailer: 'TR960PE', notes: 'PRZ BRATISLAVA 23.09 BB2001B>AA1002A 1420/1700' },
        // Exact amount: nothing changes.
        { no: '79-4-26', from: 'Warszawa', ld: '2026-09-25', to: 'Budapest', ud: '2026-09-26', rev: 3000, cost: 1600, sub: 'AA1001A', trailer: 'TR100', notes: 'PRZ BRATISLAVA 25.09 AA1001A>BB2001B 1600/800' },
      ]),
      'a.xlsx',
      'daily',
    )
    expect((await issuesOf('PRZ_AMOUNT_MISMATCH')).map(i => i.ref)).toEqual(['79-3-26'])

    const one = await board.orderDetails('79-1-26')
    expect(one.order.skonto).toBe(true)
    expect(one.legs.map(l => [l.plate, l.amount, l.amountGross])).toEqual([
      ['AA1001A', 1576, 1600],
      ['BB2001B', 800, null],
    ])
    expect(one.order.amountsTotal).toBe(2376)
    expect(one.order.margin).toBe(624)

    const both = await board.orderDetails('79-2-26')
    expect(both.legs.map(l => [l.amount, l.amountGross])).toEqual([
      [985, 1000],
      [985, 1000],
    ])
    expect((await board.orderDetails('79-4-26')).legs.map(l => [l.amount, l.amountGross])).toEqual([
      [1600, null],
      [800, null],
    ])
    // The truck's totals use the amount after skonto.
    const bar = (await rowOf('AA1001A')).bars.find(b => b.orderNo === '79-1-26')!
    expect(bar.amount).toBe(1576)
    expect(bar.noteLines).toContain('Kwota po skoncie: 1576 € (1600 € − 1,5%).')
  })

  it('doładunek: "Doładunek do <order>" in the notes rides with the main order — no km of its own, no route check, money counts', async () => {
    const rows: Row[] = [
      { no: '79-10-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest + Praha 6', ud: '2026-09-23', rev: 2600, cost: 2100, sub: 'AA1001A', trailer: 'TR100' },
      { no: '79-11-26', from: 'Budapest', ld: '2026-09-23', to: 'Praha 6', ud: '2026-09-23', rev: 400, cost: 300, sub: 'AA1001A', trailer: 'TR100', notes: 'dołądunek do 79-10-26-S' },
      { no: '79-12-26', from: 'Praha 6', ld: '2026-09-24', to: 'Warszawa', ud: '2026-09-25', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR100' },
    ]
    // A typo in the keyword ("dołądunek") is folded too — only the number must be there.
    await board.importFile(await xlsx(rows), 'a.xlsx', 'daily')
    let co = await board.orderDetails('79-11-26')
    expect(co.order.coLoad).toMatchObject({ of: '79-10-26', valid: true, source: 'notes' })
    expect(co.legs[0]).toMatchObject({ kmLoaded: 0, kmEmpty: 0, coLoad: true, amount: 300 })
    expect((await board.orderDetails('79-10-26')).order.coLoads).toEqual(['79-11-26'])
    // The next empty run starts at the main order's unloading.
    expect((await board.orderDetails('79-12-26')).legs[0]).toMatchObject({ kmEmptyFrom: 'Praga', kmEmpty: 0 })
    expect(await issuesOf('ROUTE_GAP')).toEqual([])
    expect(await issuesOf('COLOAD')).toEqual([])
    const row = await rowOf('AA1001A')
    expect(row.bars.find(b => b.orderNo === '79-11-26')?.coLoadOf).toBe('79-10-26')
    expect(row.totals.legs).toBe(3)
    expect(row.totals.revenue).toBe(4200)

    // The board correction "-" = not a co-load: a normal order again, with its own km and the route check.
    await board.setOverride('79-11-26', 'coload', '-')
    co = await board.orderDetails('79-11-26')
    expect(co.order.coLoad).toBeNull()
    expect(co.legs[0]!.kmEmpty).toBeGreaterThan(500)
    expect((await issuesOf('ROUTE_GAP')).map(i => i.ref)).toEqual(['79-11-26'])
    await board.clearOverride('79-11-26', 'coload')
    expect(await issuesOf('ROUTE_GAP')).toEqual([])

    await expect(board.setOverride('79-11-26', 'coload', 'abc')).rejects.toMatchObject({ code: 'BAD_ORDER_NO' })
    await expect(board.setOverride('79-11-26', 'coload', '79-11-26')).rejects.toMatchObject({ code: 'BAD_ORDER_NO' })
    await expect(board.setOverride('79-11-26', 'coload', '79-99-26')).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })

  it('doładunek: main order on another truck, missing or cancelled → a normal order and a review item; the board correction marks one', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-10-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest + Praha 6', ud: '2026-09-23', rev: 2600, cost: 2100, sub: 'AA1002A', trailer: 'TR200' },
        { no: '79-11-26', from: 'Budapest', ld: '2026-09-23', to: 'Praha 6', ud: '2026-09-23', rev: 400, cost: 300, sub: 'AA1001A', trailer: 'TR100', notes: 'Doładunek 79-10-26' },
        { no: '79-13-26', from: 'Budapest', ld: '2026-09-23', to: 'Praha 6', ud: '2026-09-23', rev: 400, cost: 300, sub: 'BB2001B', carrier: 'Beta Trans', trailer: 'TR960PE', notes: 'DOLADUNEK DO 79-77-26' },
        { no: '79-14-26', from: 'Budapest', ld: '2026-09-25', to: 'Praha 6', ud: '2026-09-25', rev: 400, cost: 300, sub: 'AA1001A', trailer: 'TR100', notes: 'doładunek' },
      ]),
      'a.xlsx',
      'daily',
    )
    const items = (await issuesOf('COLOAD')).sort((a, b) => a.ref.localeCompare(b.ref))
    expect(items.map(i => [i.ref, i.details['problem']])).toEqual([
      ['79-11-26', 'other_truck'],
      ['79-13-26', 'missing'],
      ['79-14-26', 'no_ref'],
    ])
    expect(items[0]!.message).toMatch(/79-10-26 jedzie innym autem \(AA1002A\) niż 79-11-26 \(AA1001A\)/)
    expect((await board.orderDetails('79-11-26')).legs[0]!.kmLoaded).toBeGreaterThan(0)

    // Marked on the board as a co-load of an order on its truck: the item closes.
    await board.importFile(
      await xlsx([{ no: '79-15-26', from: 'Warszawa', ld: '2026-09-24', to: 'Budapest + Praha 6', ud: '2026-09-26', rev: 2600, cost: 2100, sub: 'AA1001A', trailer: 'TR100' }]),
      'b.xlsx',
      'daily',
    )
    await board.setOverride('79-14-26', 'coload', '79-15-26 -S')
    expect((await board.orderDetails('79-14-26')).order.coLoad).toMatchObject({ of: '79-15-26', valid: true, source: 'manual' })
    expect((await board.orderDetails('79-14-26')).overrides.find(o => o.field === 'coload')?.display).toBe('do 79-15-26')
    expect((await issuesOf('COLOAD')).map(i => i.ref).sort()).toEqual(['79-11-26', '79-13-26'])
  })

  it('an automatic trailer change can be typed over (day, hour, place, text) — the truck has the new trailer from then; or dismissed', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-2-26', from: 'Budapest', ld: '2026-09-25', to: 'Warszawa', ud: '2026-09-26', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR200' },
      ]),
      'a.xlsx',
      'daily',
    )
    const t1 = await truckId('AA1001A')
    let row = await rowOf('AA1001A')
    const auto = row.events.find(e => e.kind === 'trailer')!
    expect(auto).toMatchObject({ auto: true, day: '2026-09-25', text: 'BUD: TR100 → TR200', place: 'BUD', autoKey: '79-2-26:0:TR100>TR200' })
    expect(row.trailer).toBe('TR200') // today 27.09

    // It really happened on Sunday 27.09 at 21:00 in Warsaw (now: 27.09 20:00 Polish time).
    await board.addTruckEvent({ truckId: t1, day: '2026-09-27', kind: 'trailer', text: 'TR100 → TR200 na bazie', place: 'Warszawa', time: '21:00', autoKey: auto.autoKey! })
    row = await rowOf('AA1001A')
    const typed = row.events.filter(e => e.kind === 'trailer')
    expect(typed).toHaveLength(1)
    expect(typed[0]).toMatchObject({ auto: false, day: '2026-09-27', time: '21:00', text: 'TR100 → TR200 na bazie', place: 'WAW', autoKey: auto.autoKey, autoDay: '2026-09-25' })
    expect(row.trailer).toBe('TR100')
    expect(row.copyText).toMatch(/Trailer TR100/)
    await board.updateTruckEvent(typed[0]!.id!, { time: '19:30' })
    expect((await rowOf('AA1001A')).trailer).toBe('TR200')
    await expect(board.updateTruckEvent(typed[0]!.id!, { time: '25:00' })).rejects.toMatchObject({ code: 'BAD_TIME' })

    // Typed over again: the earlier entry is replaced, not doubled.
    await board.addTruckEvent({ truckId: t1, day: '2026-09-24', kind: 'trailer', text: 'zmiana w BUD', autoKey: auto.autoKey! })
    row = await rowOf('AA1001A')
    expect(row.events.filter(e => e.kind === 'trailer').map(e => [e.day, e.text])).toEqual([['2026-09-24', 'zmiana w BUD']])

    // "Usuń — nie było zmiany": no chip at all.
    const entry = row.events.find(e => e.kind === 'trailer')!
    await board.updateTruckEvent(entry.id!, { suppress: true })
    row = await rowOf('AA1001A')
    expect(row.events.filter(e => e.kind === 'trailer')).toEqual([])
    // A normal event cannot be "dismissed" that way.
    await board.addTruckEvent({ truckId: t1, day: '2026-09-23', kind: 'note', text: 'mycie' })
    const note = (await rowOf('AA1001A')).events.find(e => e.text === 'mycie')!
    await expect(board.updateTruckEvent(note.id!, { suppress: true })).rejects.toMatchObject({ code: 'NOT_AUTO' })

    // Deleting the entry brings the automatic chip back.
    await board.deleteNote(entry.id!)
    expect((await rowOf('AA1001A')).events.find(e => e.kind === 'trailer')).toMatchObject({ auto: true, day: '2026-09-25' })
    await expect(board.addTruckEvent({ truckId: t1, day: '2026-09-24', kind: 'note', text: 'x', autoKey: auto.autoKey! })).rejects.toMatchObject({ code: 'BAD_KIND' })
  })

  it('a typed-over trailer change stays as a normal "Naczepa" event when the automatic one is gone', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-2-26', from: 'Budapest', ld: '2026-09-25', to: 'Warszawa', ud: '2026-09-26', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR200' },
      ]),
      'a.xlsx',
      'daily',
    )
    const t1 = await truckId('AA1001A')
    const auto = (await rowOf('AA1001A')).events.find(e => e.kind === 'trailer')!
    await board.addTruckEvent({ truckId: t1, day: '2026-09-24', kind: 'trailer', text: 'TR100 → TR200 w BUD', autoKey: auto.autoKey!, time: '7:05' })
    await board.setOverride('79-2-26', 'trailer', 'TR100')
    const events = (await rowOf('AA1001A')).events.filter(e => e.kind === 'trailer')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ auto: false, day: '2026-09-24', time: '07:05', text: 'TR100 → TR200 w BUD' })
    expect(events[0]!.autoKey).toBeUndefined()
  })

  it('day events take an optional hour', async () => {
    const t1 = await truckId('AA1001A')
    await board.addTruckEvent({ truckId: t1, day: '2026-09-22', kind: 'pause', text: 'pauza 45 h', time: '6:00' })
    const ev = (await rowOf('AA1001A')).events.find(e => e.text === 'pauza 45 h')!
    expect(ev.time).toBe('06:00')
    await board.updateTruckEvent(ev.id!, { time: null })
    expect((await rowOf('AA1001A')).events.find(e => e.id === ev.id)!.time).toBeNull()
    await expect(board.addTruckEvent({ truckId: t1, day: '2026-09-22', kind: 'note', text: 'x', time: 'rano' })).rejects.toMatchObject({ code: 'BAD_TIME' })
  })

  it('a driver change with an hour: before loading the new driver, after unloading the old one, in between both; the driver now switches at it', async () => {
    await board.importFile(
      await xlsx(
        [{ no: '79-201-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-24', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100', lh: '08:00 — —', uh: '— — 12:00' }],
        HOURS_HEADERS,
      ),
      'a.xlsx',
      'daily',
    )
    const t1 = await truckId('AA1001A')
    const krzys = await board.createDriver({ name: 'Krzysztof Z.', carrier: 'Przewoźnik Alfa' })
    const driverOf = async () => (await board.orderDetails('79-201-26')).legs[0]!.driver
    await board.setDriverChange({ truckId: t1, day: '2026-09-21', driverId: krzys, time: '06:00' })
    expect(await driverOf()).toBe('Krzysztof Z.')
    const change = (await board.truckView(t1, '2026-09-21', '2026-09-21')).truck.driverChanges[0]!
    expect(change.time).toBe('06:00')
    await board.updateDriverChange(change.id, { time: '10:00' })
    expect(await driverOf()).toBe('Jan K. → Krzysztof Z. (zmiana 21.09 10:00)')
    await board.updateDriverChange(change.id, { day: '2026-09-24', time: '11:00' })
    expect(await driverOf()).toBe('Jan K. → Krzysztof Z. (zmiana 24.09 11:00)')
    await board.updateDriverChange(change.id, { time: '12:00' })
    expect(await driverOf()).toBe('Jan K.')
    // Without an hour the day rule stays: on the unloading day it belongs to the next order.
    await board.updateDriverChange(change.id, { time: null })
    expect(await driverOf()).toBe('Jan K.')
    await expect(board.updateDriverChange(change.id, { time: '9' })).rejects.toMatchObject({ code: 'BAD_TIME' })
    await board.deleteDriverChange(change.id)

    // Today (27.09, now 20:00 Polish time): a change at 21:00 is not in force yet, one at 19:00 is.
    await board.setDriverChange({ truckId: t1, day: '2026-09-27', driverId: krzys, time: '21:00' })
    let row = await rowOf('AA1001A')
    expect(row.driver).toBe('Jan K.')
    expect(row.events.find(e => e.kind === 'driver' && e.day === '2026-09-27')).toMatchObject({ text: 'Kierowca: Jan K. → Krzysztof Z.', time: '21:00' })
    await board.setDriverChange({ truckId: t1, day: '2026-09-27', driverId: krzys, time: '19:00' })
    row = await rowOf('AA1001A')
    expect(row.driver).toBe('Krzysztof Z.')
  })
})

describe('paczka 29.10.2026 — average week revenue per truck, chips at their hour', () => {
  it('"Średni obrót na auto": the trucks\' revenue (ours / the carriers\') ÷ trucks on the board that week', async () => {
    await board.importFile(
      await xlsx([
        { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1500, cost: 1200, sub: 'AA1001A', trailer: 'TR100' },
        { no: '79-2-26', from: 'Warszawa', ld: '2026-09-23', to: 'Budapest', ud: '2026-09-24', rev: 1200, cost: 900, sub: 'BB2001B', carrier: 'Beta Trans', trailer: 'TR960PE' },
      ]),
      'a.xlsx',
      'daily',
    )
    const k = (await board.weekView('2026-09-21')).kpis
    expect(k.trucks).toBe(3) // AA1002A has no order, it still counts
    expect(k.revenuePerTruck).toBe(900)
    expect(k.carrierPerTruck).toBe(700)
  })

  it('an automatic trailer change stands at the loading hour of the order with the new trailer', async () => {
    await board.importFile(
      await xlsx(
        [
          { no: '79-1-26', from: 'Warszawa', ld: '2026-09-21', to: 'Budapest', ud: '2026-09-22', rev: 1450, cost: 1250, sub: 'AA1001A', trailer: 'TR100', lh: '08:00 — —', uh: '— — 13:00' },
          { no: '79-2-26', from: 'Budapest', ld: '2026-09-23', to: 'Warszawa', ud: '2026-09-24', rev: 1200, cost: 1000, sub: 'AA1001A', trailer: 'TR200', lh: '15:30 — —', uh: '— — 12:00' },
        ],
        HOURS_HEADERS,
      ),
      'a.xlsx',
      'daily',
    )
    const row = (await board.weekView('2026-09-21')).trucks.find(t => t.plate === 'AA1001A')!
    expect(row.events.find(e => e.kind === 'trailer')).toMatchObject({ auto: true, day: '2026-09-23', time: '15:30' })
  })
})
