import { beforeEach, describe, expect, it } from 'vitest'
import { encode } from '@here/flexpolyline'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { RouteFetchError, RouteFetchService } from './routeFetchService.js'
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
