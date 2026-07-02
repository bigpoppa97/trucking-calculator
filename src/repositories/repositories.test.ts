import { beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { RouteRepository } from './routeRepository.js'
import { ConfigRepository, CONFIG_KEYS } from './configRepository.js'
import { FleetVariantRepository } from './fleetVariantRepository.js'
import { CalculationRepository, type CalculationSnapshot } from './calculationRepository.js'
import { calculateOrderCost } from '../domain/costEngine.js'
import type { CalculatorConfig } from '../domain/types.js'

let db: Kysely<DB>

beforeEach(async () => {
  db = createTestDatabase()
  await migrateToLatest(db)
})

describe('RouteRepository', () => {
  const repo = () => new RouteRepository(db)

  it('creates and hydrates a route with per-country km and tolls', async () => {
    await repo().create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'manual',
      createdBy: 'test',
      countryKm: { PL: 420, CZ: 260 },
      tolls: [
        { country: 'PL', tollEur: 102, status: 'verified', verifiedBy: 'test', verifiedAt: '2026-07-02T00:00:00Z' },
        { country: 'CZ', tollEur: 35, status: 'estimate', fetchedAt: '2026-07-02T00:00:00Z' },
      ],
    })

    const route = await repo().findByCode('WAW-PRG')
    expect(route).not.toBeNull()
    expect(route?.stops).toEqual(['WAW', 'PRG'])
    expect(route?.countryKm).toEqual({ PL: 420, CZ: 260 })
    expect(route?.tolls).toHaveLength(2)
    expect(route?.tolls.find(t => t.country === 'CZ')?.status).toBe('estimate')
    expect(route?.tollsPendingCountries).toEqual([])
  })

  it('reports countries with km but no toll row as pending', async () => {
    await repo().create({
      routeCode: 'WAW-MAD',
      totalKm: 2842,
      kmSource: 'manual',
      createdBy: 'test',
      countryKm: { PL: 466, DE: 705 },
      tolls: [],
    })
    const route = await repo().findByCode('WAW-MAD')
    expect(route?.tollsPendingCountries.sort()).toEqual(['DE', 'PL'])
  })

  it('rejects malformed route codes', async () => {
    await expect(
      repo().create({ routeCode: 'WAW', totalKm: 1, kmSource: 'manual', createdBy: 'test', countryKm: {}, tolls: [] }),
    ).rejects.toThrow(/route code/i)
    await expect(
      repo().create({ routeCode: 'waw-prg', totalKm: 1, kmSource: 'manual', createdBy: 'test', countryKm: {}, tolls: [] }),
    ).rejects.toThrow(/route code/i)
  })

  it('enforces unique route codes', async () => {
    const input = {
      routeCode: 'WAW-FRA',
      totalKm: 1080,
      kmSource: 'manual' as const,
      createdBy: 'test',
      countryKm: {},
      tolls: [],
    }
    await repo().create(input)
    await expect(repo().create(input)).rejects.toThrow(/unique/i)
  })

  it('manual km override replaces distances and flips km_source (PRD §3.3)', async () => {
    await repo().create({
      routeCode: 'WAW-PRG',
      totalKm: 700,
      kmSource: 'here',
      createdBy: 'test',
      countryKm: { PL: 430, CZ: 270 },
      tolls: [{ country: 'PL', tollEur: 102, status: 'verified' }],
    })

    await repo().overrideKm('WAW-PRG', 680, { PL: 420, CZ: 260 })

    const route = await repo().findByCode('WAW-PRG')
    expect(route?.totalKm).toBe(680)
    expect(route?.kmSource).toBe('manual')
    expect(route?.countryKm).toEqual({ PL: 420, CZ: 260 })
    // Tolls untouched by a km override
    expect(route?.tolls).toHaveLength(1)
  })

  it('promotes an estimate to verified with audit fields (PRD §4.3)', async () => {
    const created = await repo().create({
      routeCode: 'VIE-WAW',
      totalKm: 675,
      kmSource: 'here',
      createdBy: 'test',
      countryKm: { PL: 349, CZ: 229, AT: 96 },
      tolls: [{ country: 'AT', tollEur: 38, status: 'estimate', fetchedAt: '2026-07-01T00:00:00Z' }],
    })

    await repo().verifyToll(created.id, 'AT', 'finance@company', 39.5)

    const route = await repo().findByCode('VIE-WAW')
    const at = route?.tolls.find(t => t.country === 'AT')
    expect(at?.status).toBe('verified')
    expect(at?.tollEur).toBe(39.5)
    expect(at?.verifiedBy).toBe('finance@company')
    expect(at?.verifiedAt).toBeTruthy()
  })

  it('deleting a route cascades to km and toll rows', async () => {
    const created = await repo().create({
      routeCode: 'WAW-BUD',
      totalKm: 704,
      kmSource: 'manual',
      createdBy: 'test',
      countryKm: { PL: 391, SK: 207, HU: 106 },
      tolls: [{ country: 'PL', tollEur: 102, status: 'verified' }],
    })
    await db.deleteFrom('routes').where('id', '=', created.id).execute()
    const km = await db.selectFrom('route_country_km').selectAll().where('route_id', '=', created.id).execute()
    const tolls = await db.selectFrom('route_country_toll').selectAll().where('route_id', '=', created.id).execute()
    expect(km).toEqual([])
    expect(tolls).toEqual([])
  })
})

describe('ConfigRepository', () => {
  it('round-trips config and builds a typed CalculatorConfig', async () => {
    const repo = new ConfigRepository(db)
    await repo.setMany({
      [CONFIG_KEYS.fuelPrice]: '1.4',
      [CONFIG_KEYS.consumption]: '28',
      [CONFIG_KEYS.driverDayRate]: '160',
      [CONFIG_KEYS.monthlyOverhead]: '3012',
      [CONFIG_KEYS.monthDays]: '30',
    })
    const config = await repo.getCalculatorConfig()
    expect(config).toEqual<CalculatorConfig>({
      fuelPriceEurPerLitre: 1.4,
      fuelConsumptionLPer100Km: 28,
      driverDayRateEur: 160,
      monthlyOverheadEur: 3012,
      monthDays: 30,
    })
  })

  it('fails loudly when a config key is missing — no silent defaults', async () => {
    const repo = new ConfigRepository(db)
    await repo.setMany({ [CONFIG_KEYS.fuelPrice]: '1.4' })
    await expect(repo.getCalculatorConfig()).rejects.toThrow(/missing 'consumption'/)
  })
})

describe('FleetVariantRepository', () => {
  it('upserts by name and filters active variants', async () => {
    const repo = new FleetVariantRepository(db)
    await repo.upsertByName('standard cooler', 2750)
    await repo.upsertByName('mega COOL', 4500)
    await repo.upsertByName('mega curtain', 3200)
    await repo.upsertByName('mega curtain', 3300, false) // price update + deactivate

    const active = await repo.listActive()
    expect(active.map(v => v.name).sort()).toEqual(['mega COOL', 'standard cooler'])
    expect((await repo.findByName('mega curtain'))?.monthlyCostEur).toBe(3300)
    expect((await repo.findByName('mega curtain'))?.active).toBe(false)
  })
})

describe('CalculationRepository — frozen snapshots (PRD §5.2)', () => {
  it('a saved snapshot is not altered by later config changes', async () => {
    const configRepo = new ConfigRepository(db)
    await configRepo.setMany({
      [CONFIG_KEYS.fuelPrice]: '1.4',
      [CONFIG_KEYS.consumption]: '28',
      [CONFIG_KEYS.driverDayRate]: '160',
      [CONFIG_KEYS.monthlyOverhead]: '3012',
      [CONFIG_KEYS.monthDays]: '30',
    })
    const variantRepo = new FleetVariantRepository(db)
    await variantRepo.upsertByName('standard cooler', 2750)
    const variant = await variantRepo.findByName('standard cooler')
    const routeRepo = new RouteRepository(db)
    const route = await routeRepo.create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'manual',
      createdBy: 'test',
      countryKm: { PL: 420, CZ: 260 },
      tolls: [
        { country: 'PL', tollEur: 102, status: 'verified' },
        { country: 'CZ', tollEur: 35, status: 'verified' },
      ],
    })

    const config = await configRepo.getCalculatorConfig()
    const result = calculateOrderCost(
      {
        totalKm: 680,
        orderDays: 1,
        driverCount: 1,
        fleetMonthlyCostEur: variant!.monthlyCostEur,
        tolls: route.tolls.map(t => ({ country: t.country, tollEur: t.tollEur, status: t.status })),
        ferriesTunnelsEur: 0,
      },
      config,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const snapshot: CalculationSnapshot = {
      input: {
        routeCode: 'WAW-PRG',
        totalKm: 680,
        orderDays: 1,
        driverCount: 1,
        fleetVariantName: variant!.name,
        fleetMonthlyCostEur: variant!.monthlyCostEur,
        ferriesEur: 0,
        tunnelsEur: 0,
      },
      config,
      breakdown: result.breakdown,
    }
    const calcRepo = new CalculationRepository(db)
    const id = await calcRepo.create({
      routeId: route.id,
      days: 1,
      drivers: 1,
      fleetVariantId: variant!.id,
      ferriesEur: 0,
      tunnelsEur: 0,
      snapshot,
      createdBy: 'test',
    })

    // Finance changes the config afterwards — snapshot must stay frozen.
    await configRepo.setMany({ [CONFIG_KEYS.fuelPrice]: '1.95', [CONFIG_KEYS.monthlyOverhead]: '4000' })

    const saved = await calcRepo.findById(id)
    expect(saved?.snapshot.config.fuelPriceEurPerLitre).toBe(1.4)
    expect(saved?.snapshot.config.monthlyOverheadEur).toBe(3012)
    expect(saved?.snapshot.breakdown.totalEur).toBe(result.breakdown.totalEur)
  })

  it('rejects a calculation referencing a nonexistent route (FK)', async () => {
    const variantRepo = new FleetVariantRepository(db)
    await variantRepo.upsertByName('standard cooler', 2750)
    const variant = await variantRepo.findByName('standard cooler')
    const calcRepo = new CalculationRepository(db)
    await expect(
      calcRepo.create({
        routeId: 9999,
        days: 1,
        drivers: 1,
        fleetVariantId: variant!.id,
        ferriesEur: 0,
        tunnelsEur: 0,
        snapshot: {} as CalculationSnapshot,
        createdBy: 'test',
      }),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })
})
