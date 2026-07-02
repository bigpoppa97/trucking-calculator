import { beforeEach, describe, expect, it } from 'vitest'
import { encode } from '@here/flexpolyline'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { createTestDatabase, migrateToLatest } from '../db/database.js'
import { AirportRepository } from '../repositories/airportRepository.js'
import { ConfigRepository } from '../repositories/configRepository.js'
import { RouteRepository } from '../repositories/routeRepository.js'
import { RouteFetchService } from '../here/routeFetchService.js'
import type { HereRouteResponse } from '../here/hereRoutingClient.js'
import { buildApp } from './app.js'
import { loadServerEnv } from './env.js'

describe('loadServerEnv — startup assertion (kickoff Phase 3)', () => {
  it('refuses to start without HERE_API_KEY', () => {
    expect(() => loadServerEnv({})).toThrow(/HERE_API_KEY/)
    expect(() => loadServerEnv({ HERE_API_KEY: '   ' })).toThrow(/HERE_API_KEY/)
  })

  it('parses a valid environment with defaults', () => {
    const env = loadServerEnv({ HERE_API_KEY: 'k' })
    expect(env).toEqual({ hereApiKey: 'k', databasePath: 'data/calculator.sqlite', port: 3001, host: '127.0.0.1' })
  })

  it('rejects an invalid PORT', () => {
    expect(() => loadServerEnv({ HERE_API_KEY: 'k', PORT: 'abc' })).toThrow(/PORT/)
  })
})

describe('API endpoints', () => {
  let db: Kysely<DB>
  let app: FastifyInstance
  let hereCalls: number
  let hereFails: boolean

  const fakeHereResponse = (): HereRouteResponse => ({
    routes: [
      {
        sections: [
          {
            summary: { length: 680_000 },
            polyline: encode({ polyline: [[52, 20], [50.1, 14.3]], precision: 5 }),
            spans: [{ offset: 0, countryCode: 'POL' }],
            tolls: [{ countryCode: 'POL', fares: [{ id: 'f1', price: { value: 102, currency: 'EUR' } }] }],
          },
        ],
      },
    ],
  })

  beforeEach(async () => {
    db = createTestDatabase()
    await migrateToLatest(db)
    await new AirportRepository(db).upsertMany([
      { iata: 'WAW', name: 'Warsaw Chopin', city: 'Warsaw', country: 'PL', lat: 52.1657, lon: 20.9671 },
      { iata: 'PRG', name: 'Václav Havel Prague', city: 'Prague', country: 'CZ', lat: 50.1008, lon: 14.26 },
    ])
    await new ConfigRepository(db).setMany({
      fuel_price: '1.4',
      consumption: '28',
      driver_day_rate: '160',
      monthly_overhead: '3012',
      month_days: '30',
    })
    hereCalls = 0
    hereFails = false
    const fetchService = new RouteFetchService({
      client: {
        fetchRoute: async () => {
          hereCalls += 1
          if (hereFails) throw new Error('upstream detail that must never leak')
          return fakeHereResponse()
        },
      },
      airports: new AirportRepository(db),
      routes: new RouteRepository(db),
      config: new ConfigRepository(db),
      now: () => '2026-07-02T12:00:00.000Z',
    })
    app = buildApp({ db, fetchService })
  })

  it('GET /api/config returns the calculator config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { config: { monthDays: number } }
    expect(body.config.monthDays).toBe(30)
  })

  it('GET /api/fleet-variants returns active variants only', async () => {
    const { FleetVariantRepository } = await import('../repositories/fleetVariantRepository.js')
    const repo = new FleetVariantRepository(db)
    await repo.upsertByName('standard cooler', 2750)
    await repo.upsertByName('old variant', 9999, false)

    const res = await app.inject({ method: 'GET', url: '/api/fleet-variants' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { variants: Array<{ name: string }> }
    expect(body.variants.map(v => v.name)).toEqual(['standard cooler'])
  })

  it('GET /api/airports returns the airport list for autocomplete', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/airports' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { airports: Array<{ iata: string }> }
    expect(body.airports.map(a => a.iata)).toEqual(['PRG', 'WAW'])
  })

  it('GET /api/routes/:code returns the stored route with source=database (table-first)', async () => {
    await new RouteRepository(db).create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'manual',
      createdBy: 'v1-import',
      countryKm: { PL: 420, CZ: 260 },
      tolls: [{ country: 'PL', tollEur: 102, status: 'verified' }],
    })

    const res = await app.inject({ method: 'GET', url: '/api/routes/waw-prg' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { source: string; route: { routeCode: string; totalKm: number } }
    expect(body.source).toBe('database')
    expect(body.route.routeCode).toBe('WAW-PRG')
    expect(body.route.totalKm).toBe(680)
    expect(hereCalls).toBe(0) // no API call for known routes
  })

  it('GET unknown route returns the explicit not-in-database state (PRD §3.2)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/routes/WAW-OSL' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not in database.' } })
  })

  it('POST /api/here/route-fetch fetches on explicit confirmation, without saving', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/here/route-fetch',
      payload: { routeCode: 'WAW-PRG' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { source: string; fetched: { totalKm: number; tollEstimates: Record<string, number> } }
    expect(body.source).toBe('here')
    expect(body.fetched.totalKm).toBe(680)
    expect(body.fetched.tollEstimates).toEqual({ PL: 102 })
    expect(hereCalls).toBe(1)

    // Not saved: lookup still reports not-in-database
    const lookup = await app.inject({ method: 'GET', url: '/api/routes/WAW-PRG' })
    expect(lookup.statusCode).toBe(404)
  })

  it('POST /api/routes saves a fetched route, then lookup serves it from the database', async () => {
    const fetchRes = await app.inject({
      method: 'POST',
      url: '/api/here/route-fetch',
      payload: { routeCode: 'WAW-PRG' },
    })
    const { fetched } = fetchRes.json() as { fetched: Record<string, unknown> }

    const saveRes = await app.inject({ method: 'POST', url: '/api/routes', payload: fetched })
    expect(saveRes.statusCode).toBe(201)

    const lookup = await app.inject({ method: 'GET', url: '/api/routes/WAW-PRG' })
    expect(lookup.statusCode).toBe(200)
    const body = lookup.json() as { route: { kmSource: string; tolls: Array<{ status: string }> } }
    expect(body.route.kmSource).toBe('here')
    expect(body.route.tolls[0]?.status).toBe('estimate')

    // Saving again conflicts
    const again = await app.inject({ method: 'POST', url: '/api/routes', payload: fetched })
    expect(again.statusCode).toBe(409)
  })

  it('refuses a HERE fetch for a route already in the database (409, zero quota)', async () => {
    await new RouteRepository(db).create({
      routeCode: 'WAW-PRG',
      totalKm: 680,
      kmSource: 'manual',
      createdBy: 'v1-import',
      countryKm: {},
      tolls: [],
    })
    const res = await app.inject({ method: 'POST', url: '/api/here/route-fetch', payload: { routeCode: 'WAW-PRG' } })
    expect(res.statusCode).toBe(409)
    expect(hereCalls).toBe(0)
  })

  it('maps unknown airports to a specific 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/here/route-fetch', payload: { routeCode: 'WAW-XXX' } })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('AIRPORT_NOT_FOUND')
  })

  it('returns a graceful 502 when HERE is down — no internal details in the body', async () => {
    hereFails = true
    const res = await app.inject({ method: 'POST', url: '/api/here/route-fetch', payload: { routeCode: 'WAW-PRG' } })
    expect(res.statusCode).toBe(502)
    const body = res.body
    expect(body).not.toContain('upstream detail')
    expect((res.json() as { error: { code: string } }).error.code).toBe('HERE_UNAVAILABLE')
  })

  it('rejects malformed bodies with a 400 validation error', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/here/route-fetch', payload: { nope: true } })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION')
  })
})
