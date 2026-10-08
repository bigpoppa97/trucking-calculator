import ExcelJS from 'exceljs'
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
}

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
    }
    ws.addRow(headers.map(h => byHeader[h] ?? null))
  }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

let db: Kysely<DB>
let distances: DistanceService
let now = '2026-09-27T18:00:00Z'
let board: BoardService

beforeEach(async () => {
  db = createTestDatabase()
  await migrateToLatest(db)
  await ensurePlaceSeed(db)
  distances = new DistanceService({ db, allowHere: false })
  now = '2026-09-27T18:00:00Z'
  board = new BoardService(db, distances, { now: () => now, actor: 'test' })
  // Fleet: two trucks of carrier Alfa, one of Beta; trailers.
  await board.createTruck({ plate: 'AA1001A', validFrom: '2026-01-01', carrier: 'Przewoźnik Alfa', driver: 'Jan K.', phone: '600100100', trailerPlate: 'TR100' })
  await board.createTruck({ plate: 'AA1002A', validFrom: '2026-01-01', carrier: 'Przewoźnik Alfa', driver: 'Ewa L.' })
  await board.createTruck({ plate: 'BB2001B', validFrom: '2026-01-01', carrier: 'Beta Trans', driver: 'Piotr M.' })
  for (const plate of ['TR100', 'TR200', 'TR960PE']) await board.upsertTrailer({ plate })
})

afterEach(async () => {
  await db.destroy()
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
