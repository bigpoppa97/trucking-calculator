import { alpha3ToAlpha2 } from './countryCodes.js'
import { splitKmByCountry } from './polylineCountrySplit.js'
import { roundEur } from '../domain/money.js'
import type { HereRouteResponse } from './hereRoutingClient.js'
import type { TollSystemRule } from '../repositories/tollSystemRuleRepository.js'

/**
 * Turns a raw HERE v8 response into the app's route shape (PRD §4.2):
 * - `summary.length` is in METRES → /1000
 * - multi-stop routes return MULTIPLE sections → iterate ALL and sum
 * - country codes arrive as alpha-3 → converted to alpha-2
 * - per-country km from polyline + haversine within span ranges
 * - toll fares are deduplicated by fare id across sections (the same fare
 *   can apply to several sections and must be counted once)
 * - toll-system correction rules fix fares HERE prices at the wrong tariff
 *   (e.g. private A2 gates billed at the oversized category); corrected
 *   values remain estimates
 */

export interface RoutePolylineSection {
  /** Raw HERE flexible-polyline string — decoded on the frontend. */
  polyline: string
  /** Span offsets into the decoded polyline, country as alpha-2. */
  spans: Array<{ offset: number; country: string }>
}

export interface ParsedHereRoute {
  totalKm: number
  /** km per alpha-2 country. */
  countryKm: Record<string, number>
  /** EUR toll estimate per alpha-2 country. */
  tollEstimates: Record<string, number>
  /** One entry per HERE section, for the map preview. */
  sections: RoutePolylineSection[]
  warnings: string[]
}

const roundKm = (km: number): number => Math.round(km * 10) / 10

export function parseHereRoute(response: HereRouteResponse, tollRules: TollSystemRule[] = []): ParsedHereRoute {
  const warnings: string[] = []
  const ruleBySystem = new Map(tollRules.map(rule => [rule.tollSystem.trim().toUpperCase(), rule]))
  const route = response.routes[0]
  if (!route || route.sections.length === 0) {
    throw new Error('HERE response contains no route sections.')
  }
  if (response.routes.length > 1) {
    warnings.push(`HERE returned ${response.routes.length} route alternatives — using the first.`)
  }

  let totalMetres = 0
  const kmByAlpha3: Record<string, number> = {}
  const tollByAlpha3: Record<string, number> = {}
  const seenFareIds = new Set<string>()
  const sections: RoutePolylineSection[] = []
  // Rule corrections are aggregated into ONE warning per toll system —
  // HU-GO style systems return 40+ tiny per-segment fares.
  const ruleTotals = new Map<string, { count: number; fromEur: number; toEur: number }>()

  for (const [index, section] of route.sections.entries()) {
    totalMetres += section.summary.length

    for (const notice of section.notices ?? []) {
      if (notice.code === 'tollsDataUnavailable') {
        warnings.push(`Section ${index + 1}: HERE could not calculate tolls (tollsDataUnavailable).`)
      }
    }

    sections.push({
      polyline: section.polyline,
      spans: (section.spans ?? []).map(span => ({
        offset: span.offset,
        country: alpha3ToAlpha2(span.countryCode) ?? span.countryCode,
      })),
    })

    const split = splitKmByCountry(section.polyline, section.spans ?? [])
    warnings.push(...split.warnings.map(w => `Section ${index + 1}: ${w}`))
    for (const [alpha3, km] of Object.entries(split.kmByCountry)) {
      kmByAlpha3[alpha3] = (kmByAlpha3[alpha3] ?? 0) + km
    }

    for (const toll of section.tolls ?? []) {
      const alpha3 = toll.countryCode
      if (!alpha3) {
        warnings.push(`Section ${index + 1}: toll entry without a country code — skipped.`)
        continue
      }
      // HERE lists the fares that MAY apply (time of day, payment method).
      // Best effort: take the first fare, as the router orders by relevance.
      const fare = toll.fares[0]
      if (!fare) continue
      if (seenFareIds.has(fare.id)) continue
      seenFareIds.add(fare.id)

      // currency=EUR was requested; prefer convertedPrice when HERE provides
      // it, fall back to price. Non-EUR amounts are excluded, not guessed.
      const price = fare.convertedPrice ?? fare.price
      if (price?.value === undefined) {
        warnings.push(`Toll in ${alpha3} has no price value — excluded from the estimate.`)
        continue
      }
      if (price.currency !== undefined && price.currency !== 'EUR') {
        warnings.push(`Toll in ${alpha3} is priced in ${price.currency}, not EUR — excluded from the estimate.`)
        continue
      }

      let eur = price.value
      const rule = toll.tollSystem ? ruleBySystem.get(toll.tollSystem.trim().toUpperCase()) : undefined
      if (rule) {
        const corrected = applyTollRule(rule, fare, eur)
        if (corrected === null) {
          warnings.push(
            `Toll rule for '${rule.tollSystem}' could not be applied (no original-currency price on the fare) — HERE value kept.`,
          )
        } else {
          const totals = ruleTotals.get(rule.tollSystem) ?? { count: 0, fromEur: 0, toEur: 0 }
          totals.count += 1
          totals.fromEur += eur
          totals.toEur += corrected
          ruleTotals.set(rule.tollSystem, totals)
          eur = corrected
        }
      }
      tollByAlpha3[alpha3] = (tollByAlpha3[alpha3] ?? 0) + eur
    }
  }

  for (const [system, totals] of ruleTotals) {
    warnings.push(
      `Toll rule applied to '${system}': ${totals.count} ${totals.count === 1 ? 'fare' : 'fares'} corrected, €${roundEur(totals.fromEur)} → €${roundEur(totals.toEur)}.`,
    )
  }

  const countryKm: Record<string, number> = {}
  for (const [alpha3, km] of Object.entries(kmByAlpha3)) {
    const alpha2 = alpha3ToAlpha2(alpha3)
    if (alpha2 === null) {
      warnings.push(`Unknown country code '${alpha3}' in spans — its ${roundKm(km)} km are not attributed.`)
      continue
    }
    countryKm[alpha2] = roundKm(km)
  }

  const tollEstimates: Record<string, number> = {}
  for (const [alpha3, eur] of Object.entries(tollByAlpha3)) {
    const alpha2 = alpha3ToAlpha2(alpha3)
    if (alpha2 === null) {
      warnings.push(`Unknown country code '${alpha3}' in tolls — €${roundEur(eur)} not attributed.`)
      continue
    }
    tollEstimates[alpha2] = roundEur(eur)
  }

  return {
    totalKm: roundKm(totalMetres / 1000),
    countryKm,
    tollEstimates,
    sections,
    warnings,
  }
}

type HereFare = { price?: { value?: number; currency?: string }; convertedPrice?: { value?: number; currency?: string } }

/**
 * Returns the corrected EUR amount for one fare, or null when the rule
 * cannot be applied. 'replace_per_gate' values are in the fare's ORIGINAL
 * currency (e.g. 105 PLN) and are converted with the fare's own FX ratio,
 * so the rule survives exchange-rate movement.
 */
function applyTollRule(rule: TollSystemRule, fare: HereFare, eur: number): number | null {
  if (rule.ruleType === 'scale') return eur * rule.value
  const original = fare.price?.value
  if (original === undefined || original <= 0) return null
  if (fare.price?.currency === 'EUR') return rule.value
  const convertedEur = fare.convertedPrice?.value
  if (convertedEur === undefined || fare.convertedPrice?.currency !== 'EUR') return null
  return rule.value * (convertedEur / original)
}
