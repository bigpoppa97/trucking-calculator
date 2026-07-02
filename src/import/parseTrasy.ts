import { parse } from 'csv-parse/sync'
import { parseDecimalInput } from '../domain/money.js'
import { ROUTE_CODE_REGEX } from '../repositories/routeRepository.js'

/**
 * Parser for the v1 Google Sheet "Trasy" tab export (PRD §6).
 *
 * Column conventions in the export:
 * - "Route ID" is authoritative for stops (hyphen-separated IATA codes).
 *   "Z"/"Do"/"Via" hold city names or border-crossing notes in older rows —
 *   they are informational only and not imported.
 * - Per-country columns follow "<CC> km" and "Toll <CC>" naming.
 *
 * Toll import policy: a toll > 0 is a curated sheet value → imported as
 * 'verified' (the sheet was the production source of truth). A toll of 0 in
 * a country with km > 0 is treated as NOT YET FILLED IN → no toll row, so
 * the route shows as "tolls pending" (PRD §3.2). This includes Baltic zeros;
 * finance can bulk-verify those quickly via the pending filter.
 */

export interface ParsedRoute {
  routeCode: string
  totalKm: number
  countryKm: Record<string, number>
  /** Curated sheet tolls (value > 0) — imported as verified. */
  tolls: Array<{ country: string; tollEur: number }>
  /** Countries with km > 0 but toll 0/empty — left pending. */
  pendingTollCountries: string[]
}

export interface ParsedTrasy {
  routes: ParsedRoute[]
  warnings: string[]
}

const KM_COLUMN = /^([A-Z]{2}) km$/
const TOLL_COLUMN = /^Toll ([A-Z]{2})$/

export function parseTrasy(csvContent: string): ParsedTrasy {
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>

  const routes: ParsedRoute[] = []
  const warnings: string[] = []

  for (const record of records) {
    const routeCode = (record['Route ID'] ?? '').trim().toUpperCase()
    if (routeCode === '') continue
    if (!ROUTE_CODE_REGEX.test(routeCode)) {
      warnings.push(`Trasy: invalid route code '${routeCode}' — row skipped.`)
      continue
    }

    const totalKm = parseDecimalInput(record['Total KM'] ?? '')
    if (totalKm === null || totalKm <= 0) {
      warnings.push(`Trasy: route ${routeCode} has invalid Total KM '${record['Total KM']}' — row skipped.`)
      continue
    }

    const countryKm: Record<string, number> = {}
    const tolls: ParsedRoute['tolls'] = []
    const pendingTollCountries: string[] = []

    for (const [column, raw] of Object.entries(record)) {
      const kmMatch = KM_COLUMN.exec(column)
      if (kmMatch) {
        const km = parseDecimalInput(raw ?? '')
        if (km === null) {
          warnings.push(`Trasy: route ${routeCode} has non-numeric km for ${kmMatch[1]} — treated as 0.`)
        } else if (km < 0) {
          warnings.push(`Trasy: route ${routeCode} has negative km for ${kmMatch[1]} — treated as 0.`)
        } else if (km > 0) {
          countryKm[kmMatch[1]!] = km
        }
      }
    }

    for (const [column, raw] of Object.entries(record)) {
      const tollMatch = TOLL_COLUMN.exec(column)
      if (!tollMatch) continue
      const country = tollMatch[1]!
      const toll = parseDecimalInput(raw ?? '')
      if (toll === null || toll < 0) {
        warnings.push(`Trasy: route ${routeCode} has invalid toll for ${country} — treated as pending.`)
        if (countryKm[country] !== undefined) pendingTollCountries.push(country)
      } else if (toll > 0) {
        if (countryKm[country] === undefined) {
          warnings.push(`Trasy: route ${routeCode} has a toll for ${country} but 0 km there — toll imported anyway.`)
        }
        tolls.push({ country, tollEur: toll })
      } else if (countryKm[country] !== undefined) {
        pendingTollCountries.push(country)
      }
    }

    const trackedSum = Object.values(countryKm).reduce((a, b) => a + b, 0)
    if (trackedSum > totalKm + 1) {
      warnings.push(
        `Trasy: route ${routeCode} tracked per-country km (${trackedSum}) exceeds total (${totalKm}) — check the sheet.`,
      )
    }

    routes.push({ routeCode, totalKm, countryKm, tolls, pendingTollCountries })
  }

  const codes = new Set<string>()
  for (const r of routes) {
    if (codes.has(r.routeCode)) warnings.push(`Trasy: duplicate route code ${r.routeCode} — only the first is imported.`)
    codes.add(r.routeCode)
  }

  return { routes, warnings }
}
