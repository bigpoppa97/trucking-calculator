import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { FleetVariantRepository } from '../repositories/fleetVariantRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { RouteFetchService } from '../here/routeFetchService.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { buildApp } from './app.js'
import type { RouteDetails } from '../repositories/routeRepository.js'
import type { SavedCalculation } from '../repositories/calculationRepository.js'

let db: Kysely<DB>
let app: FastifyInstance

beforeEach(async () => {
  db = createTestDatabase()
  await migrateToLatest(db)
  await new ConfigRepository(db).setMany({
    fuel_price: '1.4',
    consumption: '28',
    driver_day_rate: '160',
    monthly_overhead: '3012',
    month_days: '30',
  })
  const variantRepo = new FleetVariantRepository(db)
  await variantRepo.upsertByName('standard cooler', 2750)
  await variantRepo.upsertByName('mega COOL', 4500)
  await new RouteRepository(db).create({
    routeCode: 'WAW-PRG',
    totalKm: 680,
    kmSource: 'here',
    createdBy: 'test',
    countryKm: { PL: 420, CZ: 260, DE: 10 },
    tolls: [
      { country: 'PL', tollEur: 102, status: 'verified', verifiedBy: 'v1-import', verifiedAt: '2026-01-01' },
      { country: 'CZ', tollEur: 33, status: 'estimate', fetchedAt: '2026-06-01' },
      // DE has km but no toll row → pending
    ],
  })
  const fetchService = new RouteFetchService({
    client: { fetchRoute: async () => ({ routes: [] }) },
    airports: new AirportRepository(db),
    routes: new RouteRepository(db),
    config: new ConfigRepository(db),
  })
  app = buildApp({ db, fetchService })
})

const getRoute = (body: string): RouteDetails => (JSON.parse(body) as { route: RouteDetails }).route

describe('route DB endpoints (PRD §5.3)', () => {
  it('GET /api/routes lists summaries with pending/estimate flags', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/routes' })
    expect(res.statusCode).toBe(200)
    const { routes } = res.json() as { routes: Array<{ routeCode: string; tollsPending: boolean; hasEstimates: boolean }> }
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ routeCode: 'WAW-PRG', tollsPending: true, hasEstimates: true })
  })

  it('PUT …/km overrides distances with audit note and flips source to manual', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/routes/WAW-PRG/km',
      payload: { totalKm: 690, countryKm: { PL: 425, CZ: 265 }, note: 'przejście Kudowa-Zdrój' },
    })
    expect(res.statusCode).toBe(200)
    const route = getRoute(res.body)
    expect(route.totalKm).toBe(690)
    expect(route.kmSource).toBe('manual')
    expect(route.kmNote).toBe('przejście Kudowa-Zdrój')
    expect(route.kmUpdatedBy).toBe('portal-user')
    expect(route.kmUpdatedAt).toBeTruthy()
  })

  it('PUT …/tolls/:country fills a pending toll as verified (manual entry)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/routes/WAW-PRG/tolls/DE',
      payload: { tollEur: 12.5 },
    })
    expect(res.statusCode).toBe(200)
    const route = getRoute(res.body)
    const de = route.tolls.find(t => t.country === 'DE')
    expect(de).toMatchObject({ tollEur: 12.5, status: 'verified', verifiedBy: 'portal-user' })
    expect(route.tollsPendingCountries).toEqual([])
  })

  it('POST …/tolls/:country/verify promotes an estimate with audit, optionally correcting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/routes/WAW-PRG/tolls/CZ/verify',
      payload: { correctedTollEur: 35 },
    })
    expect(res.statusCode).toBe(200)
    const cz = getRoute(res.body).tolls.find(t => t.country === 'CZ')
    expect(cz).toMatchObject({ tollEur: 35, status: 'verified', verifiedBy: 'portal-user' })
    expect(cz?.verifiedAt).toBeTruthy()
  })

  it('verify returns a specific 404 when there is no toll row', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/routes/WAW-PRG/tolls/DE/verify', payload: {} })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('TOLL_NOT_FOUND')
  })
})

describe('config endpoints (finance screen)', () => {
  it('PUT /api/config updates values; month_days stays fixed at 30', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: {
        fuelPriceEurPerLitre: 1.52,
        fuelConsumptionLPer100Km: 27.5,
        driverDayRateEur: 170,
        monthlyOverheadEur: 3200,
      },
    })
    expect(res.statusCode).toBe(200)
    const { config } = res.json() as { config: { fuelPriceEurPerLitre: number; monthDays: number } }
    expect(config.fuelPriceEurPerLitre).toBe(1.52)
    expect(config.monthDays).toBe(30)
  })

  it('strips attempts to smuggle month_days into the config payload', async () => {
    // Fastify's Ajv removes additionalProperties instead of rejecting —
    // either way, the fixed 30-day denominator cannot be changed via the API.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: {
        fuelPriceEurPerLitre: 1.4,
        fuelConsumptionLPer100Km: 28,
        driverDayRateEur: 160,
        monthlyOverheadEur: 3012,
        monthDays: 31,
      },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { config: { monthDays: number } }).config.monthDays).toBe(30)
  })

  it('fleet variant CRUD: create, reprice, deactivate', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/fleet-variants',
      payload: { name: 'mega FRIGO', monthlyCostEur: 4800 },
    })
    expect(created.statusCode).toBe(201)
    const { variants } = created.json() as { variants: Array<{ id: number; name: string }> }
    expect(variants.map(v => v.name)).toContain('mega FRIGO')

    const target = variants.find(v => v.name === 'mega FRIGO')!
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/fleet-variants/${target.id}`,
      payload: { monthlyCostEur: 4900, active: false },
    })
    expect(patched.statusCode).toBe(200)
    const after = (patched.json() as { variants: Array<{ name: string; monthlyCostEur: number; active: boolean }> }).variants
    expect(after.find(v => v.name === 'mega FRIGO')).toMatchObject({ monthlyCostEur: 4900, active: false })

    const missing = await app.inject({ method: 'PATCH', url: '/api/fleet-variants/9999', payload: { active: true } })
    expect(missing.statusCode).toBe(404)
  })
})

describe('calculation history (frozen snapshots)', () => {
  const save = () =>
    app.inject({
      method: 'POST',
      url: '/api/calculations',
      payload: { routeCode: 'WAW-PRG', days: 1, drivers: 1, fleetVariantId: 1, ferriesEur: 0, tunnelsEur: 0, revenueEur: 900 },
    })

  it('POST /api/calculations builds the snapshot server-side and returns it', async () => {
    const res = await save()
    expect(res.statusCode).toBe(201)
    const { calculation } = res.json() as { calculation: SavedCalculation & { routeCode: string } }
    expect(calculation.routeCode).toBe('WAW-PRG')
    expect(calculation.snapshot.breakdown.fuelEur).toBe(266.56)
    expect(calculation.snapshot.breakdown.tollWarnings.usesEstimates).toBe(true) // CZ estimate
    expect(calculation.snapshot.breakdown.tollWarnings.missingCountries).toEqual(['DE'])
    expect(calculation.snapshot.config.monthlyOverheadEur).toBe(3012)
    expect(calculation.createdBy).toBe('portal-user')
  })

  it('snapshots stay frozen after config changes; history is filterable by route', async () => {
    await save()
    await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { fuelPriceEurPerLitre: 1.9, fuelConsumptionLPer100Km: 28, driverDayRateEur: 160, monthlyOverheadEur: 4000 },
    })

    const history = await app.inject({ method: 'GET', url: '/api/calculations?route=WAW-PRG' })
    expect(history.statusCode).toBe(200)
    const { calculations } = history.json() as {
      calculations: Array<SavedCalculation & { routeCode: string }>
    }
    expect(calculations).toHaveLength(1)
    expect(calculations[0]?.snapshot.config.fuelPriceEurPerLitre).toBe(1.4) // frozen
    expect(calculations[0]?.snapshot.config.monthlyOverheadEur).toBe(3012)

    const other = await app.inject({ method: 'GET', url: '/api/calculations?route=WAW-BUD' })
    expect((other.json() as { calculations: unknown[] }).calculations).toEqual([])
  })

  it('returns a specific 404 for a calculation on an unsaved route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculations',
      payload: { routeCode: 'WAW-OSL', days: 1, drivers: 1, fleetVariantId: 1, ferriesEur: 0, tunnelsEur: 0 },
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('ROUTE_NOT_FOUND')
  })

  it('rejects invalid days at the schema boundary', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/calculations',
      payload: { routeCode: 'WAW-PRG', days: 0.3, drivers: 1, fleetVariantId: 1, ferriesEur: 0, tunnelsEur: 0 },
    })
    expect(res.statusCode).toBe(400)
  })
})
