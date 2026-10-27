import { describe, expect, it } from 'vitest'
import { encode } from '@here/flexpolyline'
import { findTollRule, normalizeTollName, tollRuleSignature } from './tollRules.js'
import {
  computeTollRateBaseline,
  isTollCheckStale,
  isTrustedTollSystem,
  rateWarnings,
  sanitizeTollCheck,
  unmatchedSystemWarnings,
  type TollItem,
} from './tollChecks.js'
import { parseHereRoute } from './routeParser.js'
import type { HereRouteResponse } from './hereRoutingClient.js'

const AWSA = 'A2 AUTOSTRADA WIELKOPOLSKA'
const rule = (over: Partial<{ id: number; tollSystem: string; gateFilter: string; ruleType: 'replace_per_gate' | 'scale'; value: number }> = {}) => ({
  id: 1,
  tollSystem: AWSA,
  gateFilter: '',
  ruleType: 'replace_per_gate' as const,
  value: 165,
  ...over,
})

const item = (over: Partial<TollItem> = {}): TollItem => ({
  country: 'PL',
  tollSystem: 'E-TOLL A/S',
  gates: [],
  gateCoords: [],
  hereEur: 10,
  finalEur: 10,
  originalPrice: 42.5,
  originalCurrency: 'PLN',
  ruleId: null,
  ruleSignature: null,
  ruleApplied: false,
  ...over,
})

describe('findTollRule', () => {
  it('normalises case, diacritics (incl. Ł) and spaces', () => {
    expect(normalizeTollName('  a2   Autostrada  Wielkopolska ')).toBe(AWSA)
    expect(normalizeTollName('Świecko – Łódź')).toBe('SWIECKO – LODZ')
  })

  it('does NOT match a rule named differently from the HERE system (the 06.10 defect is reported, not guessed)', () => {
    expect(findTollRule([rule({ tollSystem: 'A2 WIELKOPOLSKA' })], AWSA, [])).toBeUndefined()
    // …and a system-wide rule never spills over to a similarly named system
    expect(findTollRule([rule()], 'A2 AUTOSTRADA WIELKOPOLSKA II', [])).toBeUndefined()
  })

  it('a gate-specific rule wins over the system-wide rule; other gates keep the system rule', () => {
    const rules = [rule({ id: 1 }), rule({ id: 2, gateFilter: 'swiecko', value: 40 })]
    expect(findTollRule(rules, AWSA, ['PPO Świecko'])?.id).toBe(2)
    expect(findTollRule(rules, AWSA, ['Nowy Tomyśl'])?.id).toBe(1)
    expect(findTollRule(rules, AWSA, [])?.id).toBe(1)
  })

  it('without a system-wide rule, non-matching gates stay unruled', () => {
    expect(findTollRule([rule({ gateFilter: 'Świecko' })], AWSA, ['Komorniki'])).toBeUndefined()
  })

  it('the signature changes when the rule value or gate changes', () => {
    expect(tollRuleSignature(rule())).not.toBe(tollRuleSignature(rule({ value: 160 })))
    expect(tollRuleSignature(rule())).not.toBe(tollRuleSignature(rule({ gateFilter: 'Świecko' })))
    expect(tollRuleSignature(undefined)).toBeNull()
  })
})

describe('unmatchedSystemWarnings (PL: everything outside e-TOLL needs a rule)', () => {
  it('trusts e-TOLL names and has no expectations outside PL', () => {
    expect(isTrustedTollSystem('PL', 'E-TOLL A/S')).toBe(true)
    expect(isTrustedTollSystem('PL', 'e-toll DK')).toBe(true)
    expect(isTrustedTollSystem('PL', AWSA)).toBe(false)
    expect(isTrustedTollSystem('DE', 'TOLL COLLECT GMBH')).toBe(true)
  })

  it('reports a PL concession without a rule once per system, with gate price and total', () => {
    const warnings = unmatchedSystemWarnings([
      item(),
      item({ tollSystem: AWSA, hereEur: 94, finalEur: 94, originalPrice: 400, gates: ['Nowy Tomyśl'] }),
      item({ tollSystem: AWSA, hereEur: 103.4, finalEur: 103.4, originalPrice: 440, gates: ['Września'] }),
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`„${AWSA}” nie ma reguły korekty`)
    expect(warnings[0]).toContain('2 opłat(y)')
    expect(warnings[0]).toContain('197,40 €')
    expect(warnings[0]).toContain('400 PLN, 440 PLN')
    expect(warnings[0]).toContain('Nowy Tomyśl, Września')
  })

  it('is silent when the concession is covered by a rule', () => {
    expect(unmatchedSystemWarnings([item({ tollSystem: AWSA, ruleId: 3, ruleApplied: true })])).toEqual([])
  })
})

describe('€/km band against the company’s own routes', () => {
  // PL: median 0.12 €/km over 6 routes; one short route and a Baltic €0 are ignored.
  const samples = [0.1, 0.11, 0.12, 0.12, 0.13, 0.14].map(rate => ({ country: 'PL', km: 300, tollEur: rate * 300 }))

  it('median per country, only routes ≥150 km, needs ≥5 samples', () => {
    const baseline = computeTollRateBaseline([...samples, { country: 'PL', km: 80, tollEur: 50 }, { country: 'DE', km: 400, tollEur: 130 }])
    expect(baseline['PL']?.medianEurPerKm).toBeCloseTo(0.12, 5)
    expect(baseline['PL']?.samples).toBe(6)
    expect(baseline['DE']).toBeUndefined()
  })

  const baseline = computeTollRateBaseline(samples)

  it('flags the A2 kat.-5 overestimate (POZ-WAW-FRA 276.75 € / 837 km)', () => {
    const warnings = rateWarnings({ PL: 837.3 }, { PL: 276.75 }, [], baseline)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('PL: podejrzanie wysoka opłata — 0,33 €/km')
    expect(warnings[0]).toContain('typowo ok. 0,12 €/km na 6 trasach')
  })

  it('leaves out amounts corrected by a rule (legitimately expensive concession km)', () => {
    const items = [item({ finalEur: 13 }), item({ tollSystem: AWSA, finalEur: 140, ruleId: 1, ruleApplied: true })]
    expect(rateWarnings({ PL: 371 }, { PL: 153 }, items, baseline)).toEqual([])
  })

  it('flags a suspiciously low toll on a long stretch, ignores short ones and unknown countries', () => {
    expect(rateWarnings({ PL: 400 }, { PL: 10 }, [], baseline)[0]).toContain('podejrzanie niska opłata')
    expect(rateWarnings({ PL: 100 }, { PL: 1 }, [], baseline)).toEqual([])
    expect(rateWarnings({ FR: 400 }, { FR: 500 }, [], baseline)).toEqual([])
  })
})

describe('isTollCheckStale', () => {
  const r1 = rule({ id: 1 })
  const stored = { items: [item(), item({ tollSystem: AWSA, ruleId: 1, ruleSignature: tollRuleSignature(r1) })] }

  it('fresh while the matching rules are unchanged', () => {
    expect(isTollCheckStale(stored, [r1])).toBe(false)
  })

  it('stale after a value edit, a delete, a new gate rule or a new rule for an unruled system', () => {
    expect(isTollCheckStale(stored, [rule({ id: 1, value: 160 })])).toBe(true)
    expect(isTollCheckStale(stored, [])).toBe(true)
    expect(isTollCheckStale({ items: [item({ tollSystem: AWSA })] }, [r1])).toBe(true)
  })
})

describe('parseHereRoute — gate-specific rules and toll items', () => {
  const polyline = encode({ polyline: [[52.3, 14.6], [52.4, 17]], precision: 5 })
  const response: HereRouteResponse = {
    routes: [
      {
        sections: [
          {
            summary: { length: 250_000 },
            polyline,
            spans: [{ offset: 0, countryCode: 'POL' }],
            tolls: [
              {
                countryCode: 'POL',
                tollSystem: AWSA,
                fares: [{ id: 'sw', price: { value: 120, currency: 'PLN' }, convertedPrice: { value: 28.24, currency: 'EUR' } }],
                tollCollectionLocations: [{ name: 'Świecko', location: { lat: 52.3123, lng: 14.6111 } }],
              },
              {
                countryCode: 'POL',
                tollSystem: AWSA,
                fares: [{ id: 'nt', name: 'Nowy Tomyśl', price: { value: 400, currency: 'PLN' }, convertedPrice: { value: 94.12, currency: 'EUR' } }],
              },
            ],
          },
        ],
      },
    ],
  }

  it('prices the Świecko gate with its own rule and the others with the system rule', () => {
    const parsed = parseHereRoute(response, [rule({ id: 1 }), rule({ id: 2, gateFilter: 'Świecko', value: 40 })])
    // 40 PLN × (28.24/120) + 165 PLN × (94.12/400) = 9.41 + 38.82
    expect(parsed.tollEstimates['PL']).toBe(48.24)
    expect(parsed.matchedRuleIds.sort()).toEqual([1, 2])
    expect(parsed.tollItems.map(i => [i.gates, i.ruleId, i.hereEur, i.finalEur])).toEqual([
      [['Świecko'], 2, 28.24, 9.41],
      [['Nowy Tomyśl'], 1, 94.12, 38.82],
    ])
    expect(parsed.tollItems[0]?.gateCoords).toEqual(['52.312,14.611'])
    expect(parsed.tollItems[0]?.originalPrice).toBe(120)
  })
})

describe('sanitizeTollCheck (stored / client-sent checks)', () => {
  it('coerces malformed items instead of breaking the candidate list', () => {
    const check = sanitizeTollCheck({ checkedAt: 'x', warnings: ['w', 3], items: [{ tollSystem: 'E-TOLL A/S', gates: 'oops' }, null] })
    expect(check?.warnings).toEqual(['w'])
    expect(check?.items).toEqual([
      expect.objectContaining({ tollSystem: 'E-TOLL A/S', gates: [], hereEur: 0, ruleId: null, ruleApplied: false }),
    ])
    expect(isTollCheckStale(check!, [])).toBe(false)
  })

  it('rejects things that are not a check', () => {
    expect(sanitizeTollCheck(null)).toBeNull()
    expect(sanitizeTollCheck({ items: 'x', warnings: [] })).toBeNull()
  })
})
