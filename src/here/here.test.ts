import { describe, expect, it } from 'vitest'
import { encode } from '@here/flexpolyline'
import { alpha3ToAlpha2 } from './countryCodes.js'
import { haversineKm } from './haversine.js'
import { splitKmByCountry } from './polylineCountrySplit.js'
import { parseHereRoute } from './routeParser.js'
import { buildRouteRequestUrl, HereApiError, HereRoutingClient } from './hereRoutingClient.js'
import type { HereRouteResponse, TollVehicleProfile } from './hereRoutingClient.js'

const PROFILE: TollVehicleProfile = { axleCount: 5, grossWeightKg: 40000, emissionType: 'euro6' }

describe('alpha3ToAlpha2 (PRD §4.2)', () => {
  it.each([
    ['POL', 'PL'],
    ['DEU', 'DE'],
    ['CZE', 'CZ'],
    ['EST', 'EE'],
    ['AUT', 'AT'],
    ['fra', 'FR'], // case-insensitive
  ])('%s → %s', (alpha3, alpha2) => {
    expect(alpha3ToAlpha2(alpha3)).toBe(alpha2)
  })

  it('returns null for unknown codes instead of guessing', () => {
    expect(alpha3ToAlpha2('XYZ')).toBeNull()
  })
})

describe('haversineKm', () => {
  it('one degree of latitude is ~111.2 km', () => {
    expect(haversineKm(50, 10, 51, 10)).toBeCloseTo(111.195, 1)
  })

  it('zero distance for identical points', () => {
    expect(haversineKm(52.1657, 20.9671, 52.1657, 20.9671)).toBe(0)
  })
})

describe('splitKmByCountry (official decoder + haversine per span)', () => {
  // 4 points due north along a meridian; 1° latitude ≈ 111.195 km.
  const polyline = encode({ polyline: [[50, 10], [51, 10], [52, 10], [53, 10]], precision: 5 })

  it('splits distance between countries at span offsets', () => {
    const result = splitKmByCountry(polyline, [
      { offset: 0, countryCode: 'POL' },
      { offset: 2, countryCode: 'DEU' },
    ])
    expect(result.warnings).toEqual([])
    expect(result.kmByCountry['POL']).toBeCloseTo(222.39, 0)
    expect(result.kmByCountry['DEU']).toBeCloseTo(111.19, 0)
  })

  it('merges multiple spans of the same country', () => {
    const result = splitKmByCountry(polyline, [
      { offset: 0, countryCode: 'POL' },
      { offset: 1, countryCode: 'DEU' },
      { offset: 2, countryCode: 'POL' },
    ])
    expect(result.kmByCountry['POL']).toBeCloseTo(222.39, 0)
    expect(result.kmByCountry['DEU']).toBeCloseTo(111.19, 0)
  })

  it('warns instead of failing when spans are missing', () => {
    const result = splitKmByCountry(polyline, [])
    expect(result.kmByCountry).toEqual({})
    expect(result.warnings).toHaveLength(1)
  })
})

describe('parseHereRoute (PRD §4.2 hard-won details)', () => {
  const sectionPolyline1 = encode({ polyline: [[52, 20], [52, 21]], precision: 5 })
  const sectionPolyline2 = encode({ polyline: [[51, 18], [50.5, 16], [50, 15]], precision: 5 })

  const response: HereRouteResponse = {
    routes: [
      {
        sections: [
          {
            summary: { length: 420_000 }, // metres
            polyline: sectionPolyline1,
            spans: [{ offset: 0, countryCode: 'POL' }],
            tolls: [{ countryCode: 'POL', fares: [{ id: 'fare-pl', price: { value: 102, currency: 'EUR' } }] }],
          },
          {
            summary: { length: 260_000 },
            polyline: sectionPolyline2,
            spans: [
              { offset: 0, countryCode: 'POL' },
              { offset: 1, countryCode: 'CZE' },
            ],
            tolls: [
              // duplicate fare id spanning sections — must count ONCE
              { countryCode: 'POL', fares: [{ id: 'fare-pl', price: { value: 102, currency: 'EUR' } }] },
              { countryCode: 'CZE', fares: [{ id: 'fare-cz', convertedPrice: { value: 35, currency: 'EUR' } }] },
              // non-EUR price without conversion — excluded, with warning
              { countryCode: 'HUN', fares: [{ id: 'fare-hu', price: { value: 12500, currency: 'HUF' } }] },
            ],
          },
        ],
      },
    ],
  }

  it('sums summary.length across ALL sections and converts metres → km', () => {
    const parsed = parseHereRoute(response)
    expect(parsed.totalKm).toBe(680)
  })

  it('converts alpha-3 span countries to alpha-2 and aggregates km across sections', () => {
    const parsed = parseHereRoute(response)
    expect(Object.keys(parsed.countryKm).sort()).toEqual(['CZ', 'PL'])
    expect(parsed.countryKm['PL']).toBeGreaterThan(0)
    expect(parsed.countryKm['CZ']).toBeGreaterThan(0)
  })

  it('deduplicates toll fares by id across sections', () => {
    const parsed = parseHereRoute(response)
    expect(parsed.tollEstimates['PL']).toBe(102) // not 204
    expect(parsed.tollEstimates['CZ']).toBe(35)
  })

  it('excludes non-EUR fares with an explicit warning', () => {
    const parsed = parseHereRoute(response)
    expect(parsed.tollEstimates['HU']).toBeUndefined()
    expect(parsed.warnings.some(w => w.includes('HUF'))).toBe(true)
  })

  it('surfaces tollsDataUnavailable notices as warnings', () => {
    const withNotice: HereRouteResponse = {
      routes: [
        {
          sections: [
            {
              summary: { length: 100_000 },
              polyline: sectionPolyline1,
              spans: [{ offset: 0, countryCode: 'POL' }],
              notices: [{ code: 'tollsDataUnavailable' }],
            },
          ],
        },
      ],
    }
    const parsed = parseHereRoute(withNotice)
    expect(parsed.warnings.some(w => w.includes('tollsDataUnavailable'))).toBe(true)
  })

  it('throws on a response with no sections', () => {
    expect(() => parseHereRoute({ routes: [] })).toThrow(/no route sections/i)
  })
})

describe('buildRouteRequestUrl (params verified against current HERE docs)', () => {
  const url = buildRouteRequestUrl('https://router.hereapi.com/v8/routes', 'test-key', {
    origin: { lat: 52.1657, lon: 20.9671 },
    destination: { lat: 50.1008, lon: 14.26 },
    via: [{ lat: 52.3625, lon: 13.5007 }],
    profile: PROFILE,
  })

  it('uses the current vehicle[...] parameter family (not legacy truck[...])', () => {
    expect(url.searchParams.get('vehicle[axleCount]')).toBe('5')
    expect(url.searchParams.get('vehicle[grossWeight]')).toBe('40000')
    expect(url.searchParams.get('truck[axleCount]')).toBeNull()
  })

  it('requests truck mode, tolls in the same call, and country spans', () => {
    expect(url.searchParams.get('transportMode')).toBe('truck')
    expect(url.searchParams.get('return')).toBe('summary,polyline,tolls')
    expect(url.searchParams.get('spans')).toBe('countryCode')
    expect(url.searchParams.get('tolls[emissionType]')).toBe('euro6')
    expect(url.searchParams.get('currency')).toBe('EUR')
  })

  it('sets origin/destination and one via per intermediate stop', () => {
    expect(url.searchParams.get('origin')).toBe('52.1657,20.9671')
    expect(url.searchParams.get('destination')).toBe('50.1008,14.26')
    expect(url.searchParams.getAll('via')).toEqual(['52.3625,13.5007'])
  })
})

describe('HereRoutingClient', () => {
  const request = {
    origin: { lat: 52, lon: 20 },
    destination: { lat: 50, lon: 14 },
    via: [],
    profile: PROFILE,
  }

  it('returns parsed JSON on success', async () => {
    const client = new HereRoutingClient({
      apiKey: 'k',
      fetchFn: async () => new Response(JSON.stringify({ routes: [] }), { status: 200 }),
    })
    await expect(client.fetchRoute(request)).resolves.toEqual({ routes: [] })
  })

  it('throws HereApiError with status on non-2xx', async () => {
    const client = new HereRoutingClient({
      apiKey: 'k',
      fetchFn: async () => new Response('nope', { status: 429 }),
    })
    await expect(client.fetchRoute(request)).rejects.toMatchObject({ name: 'HereApiError', status: 429 })
  })

  it('never leaks the API key in network error messages', async () => {
    const client = new HereRoutingClient({
      apiKey: 'super-secret-key',
      fetchFn: async () => {
        throw new Error('connect ECONNREFUSED https://router.hereapi.com/?apikey=super-secret-key')
      },
    })
    const error = await client.fetchRoute(request).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HereApiError)
    expect((error as Error).message).not.toContain('super-secret-key')
  })

  it('refuses to construct without an API key', () => {
    expect(() => new HereRoutingClient({ apiKey: '' })).toThrow(/API key/)
  })
})
