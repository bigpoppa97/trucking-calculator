import { alpha3ToAlpha2 } from './countryCodes.js'
import { splitKmByCountry } from './polylineCountrySplit.js'
import { roundEur } from '../domain/money.js'
import type { HereRouteResponse } from './hereRoutingClient.js'

/**
 * Turns a raw HERE v8 response into the app's route shape (PRD §4.2):
 * - `summary.length` is in METRES → /1000
 * - multi-stop routes return MULTIPLE sections → iterate ALL and sum
 * - country codes arrive as alpha-3 → converted to alpha-2
 * - per-country km from polyline + haversine within span ranges
 * - toll fares are deduplicated by fare id across sections (the same fare
 *   can apply to several sections and must be counted once)
 */

export interface ParsedHereRoute {
  totalKm: number
  /** km per alpha-2 country. */
  countryKm: Record<string, number>
  /** EUR toll estimate per alpha-2 country. */
  tollEstimates: Record<string, number>
  warnings: string[]
}

const roundKm = (km: number): number => Math.round(km * 10) / 10

export function parseHereRoute(response: HereRouteResponse): ParsedHereRoute {
  const warnings: string[] = []
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

  for (const [index, section] of route.sections.entries()) {
    totalMetres += section.summary.length

    for (const notice of section.notices ?? []) {
      if (notice.code === 'tollsDataUnavailable') {
        warnings.push(`Section ${index + 1}: HERE could not calculate tolls (tollsDataUnavailable).`)
      }
    }

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
      tollByAlpha3[alpha3] = (tollByAlpha3[alpha3] ?? 0) + price.value
    }
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
    warnings,
  }
}
