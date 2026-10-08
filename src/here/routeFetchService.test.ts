import { beforeEach, describe, expect, it } from 'vitest'
import { encode } from '@here/flexpolyline'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { planGapFill, RouteFetchError, RouteFetchService } from './routeFetchService.js'
import type { HereRouteRequest, HereRouteResponse } from './hereRoutingClient.js'

const AIRPORTS = [
  { iata: 'WAW', name: 'Warsaw Chopin', city: 'Warsaw', country: 'PL', lat: 52.1657, lon: 20.9671 },
  { iata: 'PRG', name: 'Václav Havel Prague', city: 'Prague', country: 'CZ', lat: 50.1008, lon: 14.26 },
  { iata: 'BER', name: 'Berlin Brandenburg', city: 'Berlin', country: 'DE', lat: 52.3625, lon: 13.5007 },
  { iata: 'TLL', name: 'Tallinn Lennart Meri', city: 'Tallinn', country: 'EE', lat: 59.4133, lon: 24.8328 },
]

function fakeResponse(): HereRouteResponse {
  const polyline = encode({ polyline: [[52, 20], [51, 17], [50.1, 14.3]], precision: 5 })
  return {
    routes: [
      {
        sections: [
          {
            summary: { length: 680_000 },
            polyline,
            spans: [
              { offset: 0, countryCode: 'POL' },
              { offset: 1, countryCode: 'CZE' },
            ],
            tolls: [
              { countryCode: 'POL', fares: [{ id: 'f1', price: { value: 98.5, currency: 'EUR' } }] },
              { countryCode: 'CZE', fares: [{ id: 'f2', price: { value: 33.2, currency: 'EUR' } }] },
            ],
          },
        ],
      },
    ],
  }
}

let db: Kysely<DB>
let requests: HereRouteRequest[]

function makeService(response: HereRouteResponse | Error = fakeResponse()): RouteFetchService {
  requests = []
  return new RouteFetchService({
    client: {
      fetchRoute: async (req: HereRouteRequest) => {
        requests.push(req)
        if (response instanceof Error) throw response
        return response
      },
    },
    airports: new AirportRepository(db),
    routes: new RouteRepository(db),
    config: new ConfigRepository(db),
    now: () => '2026-07-02T12:00:00.000Z',
  })
}

beforeEach(async () => {
  db = createTestDatabase()
  await migrateToLatest(db)
  await new AirportRepository(db).upsertMany(AIRPORTS)
})

describe('RouteFetchService.fetchNewRoute', () => {
  it('resolves airports and returns parsed route data with the vehicle profile snapshot', async () => {
    const service = makeService()
    const fetched = await service.fetchNewRoute('waw-prg')

    expect(fetched.routeCode).toBe('WAW-PRG')
    expect(fetched.stops).toEqual(['WAW', 'PRG'])
    expect(fetched.totalKm).toBe(680)
    expect(fetched.tollEstimates).toEqual({ PL: 98.5, CZ: 33.2 })
    // Single global profile from config (PRD §4.3) — seeded by migration 0002
    expect(fetched.vehicleProfile).toEqual({ axleCount: 5, grossWeightKg: 40000, emissionType: 'euro6' })
    expect(fetched.fetchedAt).toBe('2026-07-02T12:00:00.000Z')

    expect(requests).toHaveLength(1)
    expect(requests[0]?.origin).toEqual({ lat: 52.1657, lon: 20.9671 })
    expect(requests[0]?.destination).toEqual({ lat: 50.1008, lon: 14.26 })
    expect(requests[0]?.via).toEqual([])
  })

  it('sends intermediate stops as via waypoints, in order', async () => {
    const service = makeService()
    await service.fetchNewRoute('WAW-BER-PRG')
    expect(requests[0]?.origin).toEqual({ lat: 52.1657, lon: 20.9671 })
    expect(requests[0]?.via).toEqual([{ lat: 52.3625, lon: 13.5007 }])
    expect(requests[0]?.destination).toEqual({ lat: 50.1008, lon: 14.26 })
  })

  it('refuses to call HERE for a route already in the database (once per route, ever)', async () => {
    await new RouteRepository(db).create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'manual',
      createdBy: 'test',
      countryKm: {},
      tolls: [],
    })
    const service = makeService()
    await expect(service.fetchNewRoute('WAW-PRG')).rejects.toMatchObject({ code: 'ROUTE_ALREADY_EXISTS' })
    expect(requests).toHaveLength(0) // no quota spent
  })

  it('rejects unknown airports before any HERE call', async () => {
    const service = makeService()
    await expect(service.fetchNewRoute('WAW-XXX')).rejects.toMatchObject({ code: 'AIRPORT_NOT_FOUND' })
    expect(requests).toHaveLength(0)
  })

  it('rejects malformed route codes', async () => {
    const service = makeService()
    await expect(service.fetchNewRoute('WAW')).rejects.toMatchObject({ code: 'INVALID_ROUTE_CODE' })
  })

  it('maps client failures to a graceful HERE_UNAVAILABLE error', async () => {
    const service = makeService(new Error('socket hang up — internal detail'))
    const error = await service.fetchNewRoute('WAW-PRG').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RouteFetchError)
    expect((error as RouteFetchError).code).toBe('HERE_UNAVAILABLE')
    expect((error as Error).message).not.toContain('socket hang up')
  })

  it('defaults Baltic countries with driven km but no toll to a €0 estimate (PRD §4.3)', async () => {
    const polyline = encode({ polyline: [[59.4, 24.8], [56.9, 24.1], [52.2, 21]], precision: 5 })
    const service = makeService({
      routes: [
        {
          sections: [
            {
              summary: { length: 1_010_000 },
              polyline,
              spans: [
                { offset: 0, countryCode: 'EST' },
                { offset: 1, countryCode: 'POL' },
              ],
              tolls: [{ countryCode: 'POL', fares: [{ id: 'f1', price: { value: 88, currency: 'EUR' } }] }],
            },
          ],
        },
      ],
    })
    const fetched = await service.fetchNewRoute('TLL-WAW')
    expect(fetched.tollEstimates['EE']).toBe(0)
    expect(fetched.tollEstimates['PL']).toBe(88)
    expect(fetched.warnings.some(w => w.includes('EE') && w.includes('€0'))).toBe(true)
  })
})

describe('RouteFetchService.saveFetchedRoute', () => {
  it('stores the route as here-sourced with estimate tolls and profile snapshots', async () => {
    const service = makeService()
    const fetched = await service.fetchNewRoute('WAW-PRG')
    const saved = await service.saveFetchedRoute(fetched, 'dispatcher@company')

    expect(saved.kmSource).toBe('here')
    expect(saved.createdBy).toBe('dispatcher@company')
    expect(saved.tolls).toHaveLength(2)
    for (const toll of saved.tolls) {
      expect(toll.status).toBe('estimate')
      expect(toll.fetchedAt).toBe('2026-07-02T12:00:00.000Z')
      expect(toll.vehicleProfile).toEqual({ axleCount: 5, grossWeightKg: 40000, emissionType: 'euro6' })
      expect(toll.verifiedBy).toBeNull()
    }

    const roundTrip = await new RouteRepository(db).findByCode('WAW-PRG')
    expect(roundTrip?.totalKm).toBe(680)
  })

  it('refuses to save over an existing route', async () => {
    const service = makeService()
    const fetched = await service.fetchNewRoute('WAW-PRG')
    await service.saveFetchedRoute(fetched, 'dispatcher@company')
    await expect(service.saveFetchedRoute(fetched, 'dispatcher@company')).rejects.toMatchObject({
      code: 'ROUTE_ALREADY_EXISTS',
    })
  })
})

describe('RouteFetchService.fillRouteGaps (existing routes, add-only)', () => {
  const repo = () => new RouteRepository(db)

  it('adds missing countries and toll estimates; keeps verified tolls, stored km and the binding total', async () => {
    await repo().create({
      routeCode: 'WAW-PRG',
      totalKm: 700, // v1 binding total — HERE says 680
      kmSource: 'manual',
      createdBy: 'v1-import',
      countryKm: { PL: 420 }, // v1 sheet had no CZ column in this scenario
      tolls: [{ country: 'PL', tollEur: 102, status: 'verified' }],
    })
    const service = makeService()
    const { route, summary } = await service.fillRouteGaps('waw-prg', 'dispatcher@company')

    expect(requests).toHaveLength(1)
    // Binding data untouched
    expect(route.totalKm).toBe(700)
    expect(route.kmSource).toBe('manual')
    expect(route.countryKm['PL']).toBe(420)
    expect(route.tolls.find(t => t.country === 'PL')).toMatchObject({ tollEur: 102, status: 'verified' })
    // Gaps filled
    expect(Object.keys(summary.addedCountryKm)).toEqual(['CZ'])
    expect(route.countryKm['CZ']).toBe(summary.addedCountryKm['CZ'])
    expect(summary.addedTolls).toEqual({ CZ: 33.2 })
    expect(route.tolls.find(t => t.country === 'CZ')).toMatchObject({
      tollEur: 33.2,
      status: 'estimate',
      fetchedAt: '2026-07-02T12:00:00.000Z',
      vehicleProfile: { axleCount: 5, grossWeightKg: 40000, emissionType: 'euro6' },
    })
    expect(summary.keptTollCountries).toEqual(['PL'])
    expect(summary.stillPendingCountries).toEqual([])
    expect(summary.hereTotalKm).toBe(680)
    // Shape stored, km change audited
    expect(route.polylineSections).toHaveLength(1)
    expect(route.kmNote).toContain('Kraje uzupełnione z HERE: CZ')
    expect(route.kmUpdatedBy).toBe('dispatcher@company')
    expect(route.kmUpdatedAt).toBe('2026-07-02T12:00:00.000Z')
  })

  it('never overwrites an existing estimate', async () => {
    await repo().create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'here',
      createdBy: 'test',
      countryKm: { PL: 420, CZ: 260 },
      tolls: [{ country: 'PL', tollEur: 50, status: 'estimate' }],
    })
    const { route, summary } = await makeService().fillRouteGaps('WAW-PRG', 'u')
    expect(route.tolls.find(t => t.country === 'PL')?.tollEur).toBe(50)
    expect(summary.addedTolls).toEqual({ CZ: 33.2 })
    // No country was missing → no km audit entry
    expect(summary.addedCountryKm).toEqual({})
    expect(route.countryKm).toEqual({ PL: 420, CZ: 260 })
    expect(route.kmNote).toBeNull()
    expect(route.kmUpdatedBy).toBeNull()
  })

  it('is a no-op on data for a complete route (still stores the shape)', async () => {
    await repo().create({
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
    const { route, summary } = await makeService().fillRouteGaps('WAW-PRG', 'u')
    expect(summary.addedCountryKm).toEqual({})
    expect(summary.addedTolls).toEqual({})
    expect(summary.keptTollCountries).toEqual(['CZ', 'PL'])
    expect(route.tolls.map(t => [t.country, t.tollEur])).toEqual(
      expect.arrayContaining([
        ['PL', 102],
        ['CZ', 35],
      ]),
    )
    expect(route.polylineSections).toHaveLength(1)
  })

  it('appends to an existing km note instead of replacing it', async () => {
    await repo().create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'manual',
      createdBy: 'test',
      countryKm: { PL: 420 },
      tolls: [],
    })
    await repo().overrideKm('WAW-PRG', 680, { PL: 420 }, { note: 'potwierdzone przez dyspozytora', updatedBy: 'd@x' })
    const { route } = await makeService().fillRouteGaps('WAW-PRG', 'f@x')
    expect(route.kmNote).toMatch(/^potwierdzone przez dyspozytora \| Kraje uzupełnione z HERE: CZ /)
    expect(route.kmUpdatedBy).toBe('f@x')
  })

  it('defaults Baltic countries without a toll to a €0 estimate, with a warning', async () => {
    await repo().create({
      routeCode: 'TLL-WAW',
      totalKm: 1010,
      kmSource: 'manual',
      createdBy: 'v1-import',
      countryKm: { EE: 200, PL: 300 },
      tolls: [],
    })
    const polyline = encode({ polyline: [[59.4, 24.8], [56.9, 24.1], [52.2, 21]], precision: 5 })
    const service = makeService({
      routes: [
        {
          sections: [
            {
              summary: { length: 1_010_000 },
              polyline,
              spans: [
                { offset: 0, countryCode: 'EST' },
                { offset: 1, countryCode: 'POL' },
              ],
              tolls: [{ countryCode: 'POL', fares: [{ id: 'f1', price: { value: 88, currency: 'EUR' } }] }],
            },
          ],
        },
      ],
    })
    const { route, summary } = await service.fillRouteGaps('TLL-WAW', 'u')
    expect(summary.addedTolls).toEqual({ EE: 0, PL: 88 })
    expect(route.tollsPendingCountries).toEqual([])
    expect(summary.warnings.some(w => w.includes('EE') && w.includes('€0'))).toBe(true)
  })

  it('refuses unknown routes before any HERE call', async () => {
    const service = makeService()
    await expect(service.fillRouteGaps('WAW-PRG', 'u')).rejects.toMatchObject({ code: 'ROUTE_NOT_FOUND' })
    expect(requests).toHaveLength(0)
  })

  it('changes nothing when HERE fails', async () => {
    await repo().create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'manual',
      createdBy: 'test',
      countryKm: { PL: 420 },
      tolls: [],
    })
    const service = makeService(new Error('socket hang up — internal detail'))
    await expect(service.fillRouteGaps('WAW-PRG', 'u')).rejects.toMatchObject({ code: 'HERE_UNAVAILABLE' })
    const route = await repo().findByCode('WAW-PRG')
    expect(route?.countryKm).toEqual({ PL: 420 })
    expect(route?.tolls).toEqual([])
    expect(route?.polylineSections).toBeNull()
  })
})

describe('planGapFill', () => {
  it('adds only countries/tolls the stored route lacks', () => {
    const plan = planGapFill(
      {
        countryKm: { PL: 466, DE: 705 },
        tolls: [
          { country: 'DE', tollEur: 181, status: 'verified', fetchedAt: null, vehicleProfile: null, verifiedBy: 'f', verifiedAt: 'x' },
        ],
      },
      { PL: 470.2, DE: 720.5, FR: 1050.3, ES: 590.1, BE: 0 },
      { PL: 60.1, DE: 245.3, FR: 312.4 },
    )
    expect(plan.addedCountryKm).toEqual({ FR: 1050.3, ES: 590.1 })
    expect(plan.addedTolls).toEqual({ PL: 60.1, FR: 312.4 })
    expect(plan.keptTollCountries).toEqual(['DE'])
  })
})
