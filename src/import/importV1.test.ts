import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { parseKonfiguracja } from './parseKonfiguracja.js'
import { parseTrasy } from './parseTrasy.js'
import { importV1 } from './importV1.js'
import { importAirports } from './importAirports.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { FleetVariantRepository } from '../repositories/fleetVariantRepository.js'

const trasyCsv = readFileSync(join(import.meta.dirname, '../../data/v1/Trasy.csv'), 'utf-8')
const konfiguracjaCsv = readFileSync(join(import.meta.dirname, '../../data/v1/Konfiguracja.csv'), 'utf-8')

describe('parseKonfiguracja (real v1 export)', () => {
  it('extracts all five config values', () => {
    const { config } = parseKonfiguracja(konfiguracjaCsv)
    expect(config).toEqual({
      fuel_price: '1.4',
      consumption: '28',
      driver_day_rate: '160',
      monthly_overhead: '3012',
      month_days: '30',
    })
  })

  it('extracts the three fleet variants', () => {
    const { variants } = parseKonfiguracja(konfiguracjaCsv)
    expect(variants).toEqual([
      { name: 'standard cooler', monthlyCostEur: 2750 },
      { name: 'mega COOL', monthlyCostEur: 4500 },
      { name: 'mega curtain', monthlyCostEur: 3200 },
    ])
  })

  it('skips the legacy standard fleet cost with a warning', () => {
    const { warnings } = parseKonfiguracja(konfiguracjaCsv)
    expect(warnings.some(w => w.includes('Koszt taboru Standard'))).toBe(true)
  })

  it('accepts comma-decimal values as the sheet may export them', () => {
    const { config } = parseKonfiguracja('Parametr,Wartość,Opis\nCena paliwa (EUR/L),"1,45",x\n')
    expect(config['fuel_price']).toBe('1.45')
  })
})

describe('parseTrasy (real v1 export)', () => {
  const parsed = parseTrasy(trasyCsv)

  it('parses all 14 routes with no skip warnings', () => {
    expect(parsed.routes).toHaveLength(14)
    expect(parsed.warnings.filter(w => w.includes('skipped'))).toEqual([])
  })

  it('parses WAW-PRG exactly as the Phase 1 reference case expects', () => {
    const wawPrg = parsed.routes.find(r => r.routeCode === 'WAW-PRG')
    expect(wawPrg).toBeDefined()
    expect(wawPrg?.totalKm).toBe(680)
    expect(wawPrg?.countryKm).toEqual({ PL: 420, CZ: 260 })
    expect(wawPrg?.tolls).toEqual([
      { country: 'PL', tollEur: 102 },
      { country: 'CZ', tollEur: 35 },
    ])
    // Reference case total tolls €137.00
    expect(wawPrg?.tolls.reduce((s, t) => s + t.tollEur, 0)).toBe(137)
    expect(wawPrg?.pendingTollCountries).toEqual([])
  })

  it('derives stops from the route code for multi-stop routes', () => {
    const multi = parsed.routes.find(r => r.routeCode === 'WAW-BER-FRA')
    expect(multi).toBeDefined()
    expect(multi?.routeCode.split('-')).toEqual(['WAW', 'BER', 'FRA'])
  })

  it('marks driven countries without sheet tolls as pending', () => {
    const wawMad = parsed.routes.find(r => r.routeCode === 'WAW-MAD')
    expect(wawMad?.countryKm).toEqual({ PL: 466, DE: 705 })
    expect(wawMad?.tolls).toEqual([])
    expect(wawMad?.pendingTollCountries.sort()).toEqual(['DE', 'PL'])

    const tllFra = parsed.routes.find(r => r.routeCode === 'TLL-FRA')
    expect(tllFra?.pendingTollCountries.sort()).toEqual(['EE', 'LT', 'LV'])
    expect(tllFra?.tolls.map(t => t.country).sort()).toEqual(['DE', 'PL'])
  })

  it('tolerates untracked countries (per-country sum below total, PRD §2.3)', () => {
    const wawMad = parsed.routes.find(r => r.routeCode === 'WAW-MAD')
    const trackedSum = Object.values(wawMad!.countryKm).reduce((a, b) => a + b, 0)
    expect(trackedSum).toBeLessThan(wawMad!.totalKm) // FR/ES km displayed but not stored
  })
})

describe('importV1 end-to-end (in-memory database)', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createTestDatabase()
    await migrateToLatest(db)
  })

  it('imports config, variants, routes, km, and tolls from the real CSVs', async () => {
    const report = await importV1(db, { trasyCsv, konfiguracjaCsv })

    expect(report.routesInserted).toHaveLength(14)
    expect(report.routesSkippedExisting).toEqual([])
    expect(report.variantsUpserted).toEqual(['standard cooler', 'mega COOL', 'mega curtain'])
    expect(report.tollsImportedVerified).toBe(17)
    expect(report.tollsLeftPending).toBe(24)

    const config = await new ConfigRepository(db).getCalculatorConfig()
    expect(config.monthlyOverheadEur).toBe(3012)
    expect(config.monthDays).toBe(30)

    const variants = await new FleetVariantRepository(db).listActive()
    expect(variants).toHaveLength(3)

    const routeRepo = new RouteRepository(db)
    const wawPrg = await routeRepo.findByCode('WAW-PRG')
    expect(wawPrg?.kmSource).toBe('manual')
    expect(wawPrg?.tolls.every(t => t.status === 'verified' && t.verifiedBy === 'v1-import')).toBe(true)
    expect(wawPrg?.tolls.reduce((s, t) => s + t.tollEur, 0)).toBe(137)

    const summaries = await routeRepo.listAll()
    expect(summaries).toHaveLength(14)
    expect(summaries.filter(s => s.tollsPending)).toHaveLength(10) // "estimates pending" filter data
  })

  it('is idempotent — a second run skips all existing routes and overwrites nothing', async () => {
    await importV1(db, { trasyCsv, konfiguracjaCsv })

    // Simulate a post-import manual correction that a re-run must not clobber.
    const routeRepo = new RouteRepository(db)
    await routeRepo.overrideKm('WAW-PRG', 690, { PL: 425, CZ: 265 })

    const report = await importV1(db, { trasyCsv, konfiguracjaCsv })
    expect(report.routesInserted).toEqual([])
    expect(report.routesSkippedExisting).toHaveLength(14)

    const wawPrg = await routeRepo.findByCode('WAW-PRG')
    expect(wawPrg?.totalKm).toBe(690)
  })
})

describe('importAirports (skeleton — dataset file pending)', () => {
  it('imports a valid airport CSV and skips malformed rows with warnings', async () => {
    const db = createTestDatabase()
    try {
      await migrateToLatest(db)
      const csv = [
        'iata,name,city,country,lat,lon',
        'WAW,Warsaw Chopin Airport,Warsaw,PL,52.1657,20.9671',
        'PRG,Václav Havel Airport Prague,Prague,CZ,50.1008,14.26',
        'XX,Broken,Nowhere,ZZ,0,0', // invalid IATA
        'BUD,Budapest Ferenc Liszt,Budapest,HU,947.5,19.26', // invalid lat
      ].join('\n')

      const report = await importAirports(db, csv)
      expect(report.imported).toBe(2)
      expect(report.warnings).toHaveLength(2)

      const again = await importAirports(db, csv) // idempotent upsert
      expect(again.imported).toBe(2)
    } finally {
      await db.destroy()
    }
  })
})
