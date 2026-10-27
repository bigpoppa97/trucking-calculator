import { roundEur } from '../domain/money.js'
import { findTollRule, normalizeTollName, tollRuleSignature, type TollRuleLike } from './tollRules.js'

/**
 * Plausibility checks on HERE toll estimates (27.10.2026):
 *
 * 1. Unmatched systems: in countries whose "trusted" toll system HERE prices
 *    correctly (PL: e-TOLL), every other system without a correction rule is
 *    flagged — HERE has priced private concessions (A2 AWSA) at the oversized
 *    category before. Driven only by the tollSystem names HERE returns.
 * 2. €/km band: a country's toll per driven km is compared with the median of
 *    the company's own stored routes in that country. Catches errors no name
 *    check can (HERE missing a toll, HERE mispricing e-TOLL itself, a typo in
 *    a rule name). Amounts corrected by a rule are left out of the HIGH check —
 *    they are deliberate (A2 concession km are legitimately ~6x e-TOLL).
 *
 * Warnings are Polish (UI text); none of them block saving.
 */

/** One HERE toll (fare) as counted in the estimate. */
export interface TollItem {
  country: string // alpha-2
  tollSystem: string
  /** Gate / fare names HERE gave for this toll (may be empty). */
  gates: string[]
  /** Gate coordinates "lat,lng" when HERE gives them (diagnostics). */
  gateCoords: string[]
  /** HERE's own EUR price. */
  hereEur: number
  /** EUR after the correction rule (= hereEur without a rule). */
  finalEur: number
  /** Price in the fare's original currency, e.g. 400 PLN. */
  originalPrice: number | null
  originalCurrency: string | null
  ruleId: number | null
  /** tollRuleSignature of the matched rule — staleness check after rule edits. */
  ruleSignature: string | null
  /** False when a rule matched but could not be applied (no original price). */
  ruleApplied: boolean
}

/** Stored per route (routes.toll_check) and returned with every HERE fetch. */
export interface TollCheck {
  checkedAt: string
  items: TollItem[]
  warnings: string[]
}

/** Toll systems HERE prices right in that country — no rule needed. */
export const TRUSTED_TOLL_SYSTEMS: Record<string, RegExp[]> = {
  PL: [/E-?TOLL/, /KRAJOWA ADMINISTRACJA SKARBOWA/, /GDDKIA/],
}

export function isTrustedTollSystem(country: string, tollSystem: string): boolean {
  const patterns = TRUSTED_TOLL_SYSTEMS[country]
  if (patterns === undefined) return true // no expectations outside the listed countries
  const name = normalizeTollName(tollSystem)
  return patterns.some(p => p.test(name))
}

const formatEurPl = (eur: number): string =>
  `${roundEur(eur).toFixed(2).replace('.', ',')} €`
const formatRatePl = (eurPerKm: number): string => `${eurPerKm.toFixed(2).replace('.', ',')} €/km`
const formatAmountPl = (value: number, currency: string): string =>
  `${Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',')} ${currency}`

export function unmatchedSystemWarnings(items: readonly TollItem[]): string[] {
  const groups = new Map<string, { country: string; system: string; count: number; eur: number; prices: Set<string>; gates: Set<string> }>()
  for (const item of items) {
    if (item.ruleId !== null) continue
    if (isTrustedTollSystem(item.country, item.tollSystem)) continue
    const key = `${item.country}|${normalizeTollName(item.tollSystem)}`
    const group = groups.get(key) ?? {
      country: item.country,
      system: item.tollSystem || '(bez nazwy)',
      count: 0,
      eur: 0,
      prices: new Set<string>(),
      gates: new Set<string>(),
    }
    group.count += 1
    group.eur += item.finalEur
    if (item.originalPrice !== null && item.originalCurrency !== null) {
      group.prices.add(formatAmountPl(item.originalPrice, item.originalCurrency))
    }
    for (const gate of item.gates) group.gates.add(gate)
    groups.set(key, group)
  }
  return [...groups.values()].map(g => {
    const prices = g.prices.size > 0 ? ` (za bramkę: ${[...g.prices].slice(0, 3).join(', ')})` : ''
    const gates = g.gates.size > 0 ? ` Bramki: ${[...g.gates].slice(0, 4).join(', ')}.` : ''
    return (
      `${g.country}: system poboru „${g.system}” nie ma reguły korekty — ${g.count} ${g.count === 1 ? 'opłata' : 'opłat(y)'}, ` +
      `razem ${formatEurPl(g.eur)}${prices}.${gates} HERE może liczyć złą kategorię pojazdu: sprawdź cennik operatora ` +
      `i w razie potrzeby dodaj regułę (Konfiguracja → Korekty systemów poboru opłat).`
    )
  })
}

/** Median €/km per country from the company's stored routes. */
export interface TollRateBaseline {
  [country: string]: { medianEurPerKm: number; samples: number }
}

/** Routes shorter than this in a country say little about its €/km. */
export const RATE_CHECK_MIN_KM = 150
/** Fewer stored routes than this → no band for the country yet. */
export const RATE_CHECK_MIN_SAMPLES = 5
/** Above median × HIGH → "podejrzanie wysoko"; below median × LOW → "podejrzanie nisko". */
export const RATE_CHECK_HIGH = 1.8
export const RATE_CHECK_LOW = 0.4

export function computeTollRateBaseline(
  samples: ReadonlyArray<{ country: string; km: number; tollEur: number }>,
): TollRateBaseline {
  const byCountry = new Map<string, number[]>()
  for (const s of samples) {
    if (!(s.km >= RATE_CHECK_MIN_KM) || !(s.tollEur >= 0)) continue
    const rates = byCountry.get(s.country) ?? []
    rates.push(s.tollEur / s.km)
    byCountry.set(s.country, rates)
  }
  const baseline: TollRateBaseline = {}
  for (const [country, rates] of byCountry) {
    if (rates.length < RATE_CHECK_MIN_SAMPLES) continue
    const sorted = [...rates].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
    if (median <= 0) continue // e.g. Baltic €0 period-pass defaults
    baseline[country] = { medianEurPerKm: median, samples: sorted.length }
  }
  return baseline
}

export function rateWarnings(
  countryKm: Readonly<Record<string, number>>,
  tollEstimates: Readonly<Record<string, number>>,
  items: readonly TollItem[],
  baseline: TollRateBaseline,
): string[] {
  const warnings: string[] = []
  for (const [country, km] of Object.entries(countryKm).sort(([a], [b]) => a.localeCompare(b))) {
    const band = baseline[country]
    const total = tollEstimates[country]
    if (band === undefined || total === undefined || !(km >= RATE_CHECK_MIN_KM)) continue

    const countryItems = items.filter(i => i.country === country)
    const ruled = countryItems.filter(i => i.ruleId !== null && i.ruleApplied).reduce((sum, i) => sum + i.finalEur, 0)
    const unruled = countryItems.length > 0 ? total - ruled : total
    const typical = `typowo ok. ${formatRatePl(band.medianEurPerKm)} na ${band.samples} trasach w bazie`

    if (unruled / km > band.medianEurPerKm * RATE_CHECK_HIGH) {
      const part = ruled > 0 ? ` (bez opłat skorygowanych regułami: ${formatEurPl(unruled)})` : ''
      warnings.push(
        `${country}: podejrzanie wysoka opłata — ${formatRatePl(unruled / km)}${part} na ${Math.round(km)} km, ` +
          `${typical}. Sprawdź szczegóły opłat; HERE mógł policzyć złą kategorię pojazdu albo brakuje reguły.`,
      )
    } else if (total / km < band.medianEurPerKm * RATE_CHECK_LOW) {
      warnings.push(
        `${country}: podejrzanie niska opłata — ${formatRatePl(total / km)} na ${Math.round(km)} km, ${typical}. ` +
          `HERE mógł pominąć płatny odcinek albo trasa omija autostrady — sprawdź przebieg na mapie.`,
      )
    }
  }
  return warnings
}

/** A stored check is out of date when any toll would now match a different rule. */
export function isTollCheckStale(check: Pick<TollCheck, 'items'>, rules: readonly TollRuleLike[]): boolean {
  return check.items.some(item => tollRuleSignature(findTollRule(rules, item.tollSystem, item.gates)) !== item.ruleSignature)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * A stored / client-sent check coerced to the TollCheck shape (the browser
 * sends it back on "Zapisz do bazy tras"). Null when it is not a check at all.
 */
export function sanitizeTollCheck(raw: unknown): TollCheck | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r['items']) || !Array.isArray(r['warnings'])) return null
  const items: TollItem[] = r['items']
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .map(i => ({
      country: str(i['country']),
      tollSystem: str(i['tollSystem']),
      gates: strList(i['gates']),
      gateCoords: strList(i['gateCoords']),
      hereEur: num(i['hereEur']),
      finalEur: num(i['finalEur']),
      originalPrice: typeof i['originalPrice'] === 'number' ? i['originalPrice'] : null,
      originalCurrency: typeof i['originalCurrency'] === 'string' ? i['originalCurrency'] : null,
      ruleId: typeof i['ruleId'] === 'number' ? i['ruleId'] : null,
      ruleSignature: typeof i['ruleSignature'] === 'string' ? i['ruleSignature'] : null,
      ruleApplied: i['ruleApplied'] === true,
    }))
  return { checkedAt: str(r['checkedAt']), items, warnings: strList(r['warnings']) }
}
