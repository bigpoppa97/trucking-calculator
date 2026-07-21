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

describe('parseHereRoute — toll-system correction rules (real defect: A2 AWSA gates)', () => {
  const polyline = encode({ polyline: [[52, 20], [52, 21]], precision: 5 })
  // Mirrors the observed WAW-CDG response: HERE bills the private A2 gates
  // at the oversized category (400–440 PLN) instead of kat. 4 (105 PLN).
  const awsaResponse = (): HereRouteResponse => ({
    routes: [
      {
        sections: [
          {
            summary: { length: 465_700 },
            polyline,
            spans: [{ offset: 0, countryCode: 'POL' }],
            tolls: [
              {
                countryCode: 'POL',
                tollSystem: 'E-TOLL A/S',
                fares: [{ id: 'etoll', price: { value: 113.24, currency: 'PLN' }, convertedPrice: { value: 26.09, currency: 'EUR' } }],
              },
              {
                countryCode: 'POL',
                tollSystem: 'A2 AUTOSTRADA WIELKOPOLSKA',
                fares: [{ id: 'gate-1', price: { value: 400, currency: 'PLN' }, convertedPrice: { value: 92.14, currency: 'EUR' } }],
              },
              {
                countryCode: 'POL',
                tollSystem: 'A2 AUTOSTRADA WIELKOPOLSKA',
                fares: [{ id: 'gate-2', price: { value: 400, currency: 'PLN' }, convertedPrice: { value: 92.14, currency: 'EUR' } }],
              },
              {
                countryCode: 'POL',
                tollSystem: 'A2 AUTOSTRADA WIELKOPOLSKA',
                fares: [{ id: 'gate-3', price: { value: 440, currency: 'PLN' }, convertedPrice: { value: 101.36, currency: 'EUR' } }],
              },
            ],
          },
        ],
      },
    ],
  })
  const AWSA_RULE = {
    id: 1,
    tollSystem: 'A2 AUTOSTRADA WIELKOPOLSKA',
    ruleType: 'replace_per_gate' as const,
    value: 105,
    note: null,
    updatedBy: null,
    updatedAt: null,
  }

  it('without rules the inflated HERE estimate passes through (~€312)', () => {
    const parsed = parseHereRoute(awsaResponse())
    expect(parsed.tollEstimates['PL']).toBe(311.73)
  })

  it('replace_per_gate converts the rule price with each fare\'s own FX ratio', () => {
    const parsed = parseHereRoute(awsaResponse(), [AWSA_RULE])
    // 26.09 + 3 gates × (105 PLN × fare FX ratio) ≈ €98.65 — matches AWSA kat. 4
    expect(parsed.tollEstimates['PL']).toBe(98.65)
    // Corrections are aggregated into a single warning per toll system.
    const ruleWarnings = parsed.warnings.filter(w => w.includes("Toll rule applied to 'A2 AUTOSTRADA WIELKOPOLSKA'"))
    expect(ruleWarnings).toHaveLength(1)
    expect(ruleWarnings[0]).toContain('3 fares corrected')
  })

  it('matches toll systems case-insensitively', () => {
    const rule = { ...AWSA_RULE, tollSystem: 'a2 autostrada wielkopolska' }
    const parsed = parseHereRoute(awsaResponse(), [rule])
    expect(parsed.tollEstimates['PL']).toBe(98.65)
  })

  it('scale rule multiplies the fare', () => {
    const rule = { ...AWSA_RULE, ruleType: 'scale' as const, value: 0.5 }
    const parsed = parseHereRoute(awsaResponse(), [rule])
    // 26.09 + (92.14 + 92.14 + 101.36) / 2
    expect(parsed.tollEstimates['PL']).toBe(168.91)
  })

  it('replace_per_gate on an EUR-priced fare uses the rule value directly', () => {
    const response: HereRouteResponse = {
      routes: [
        {
          sections: [
            {
              summary: { length: 100_000 },
              polyline,
              spans: [{ offset: 0, countryCode: 'FRA' }],
              tolls: [
                { countryCode: 'FRA', tollSystem: 'SANEF', fares: [{ id: 'f', price: { value: 50.2, currency: 'EUR' } }] },
              ],
            },
          ],
        },
      ],
    }
    const rule = { ...AWSA_RULE, tollSystem: 'SANEF', value: 42 }
    expect(parseHereRoute(response, [rule]).tollEstimates['FR']).toBe(42)
  })

  it('keeps the HERE value with a warning when the fare has no original-currency price', () => {
    const response: HereRouteResponse = {
      routes: [
        {
          sections: [
            {
              summary: { length: 100_000 },
              polyline,
              spans: [{ offset: 0, countryCode: 'POL' }],
              tolls: [
                {
                  countryCode: 'POL',
                  tollSystem: 'A2 AUTOSTRADA WIELKOPOLSKA',
                  fares: [{ id: 'g', convertedPrice: { value: 92.14, currency: 'EUR' } }],
                },
              ],
            },
          ],
        },
      ],
    }
    const parsed = parseHereRoute(response, [AWSA_RULE])
    expect(parsed.tollEstimates['PL']).toBe(92.14)
    expect(parsed.warnings.some(w => w.includes('could not be applied'))).toBe(true)
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
