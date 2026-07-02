import { decode } from '@here/flexpolyline'
import { haversineKm } from './haversine.js'

/**
 * Per-country km from a HERE section (PRD §4.2): decode the Flexible
 * Polyline via the OFFICIAL @here/flexpolyline package (never hand-rolled —
 * the version-byte bug in v1 inflated distances ~100,000×), then sum
 * haversine distances between consecutive points within each span range.
 */

/** One `spans` entry from a HERE section (spans=countryCode). */
export interface CountrySpan {
  /** Index into the section's polyline where this span starts. */
  offset: number
  /** ISO 3166-1 alpha-3 country code as returned by HERE. */
  countryCode: string
}

export interface CountrySplitResult {
  /** km per alpha-3 country code (caller converts to alpha-2). */
  kmByCountry: Record<string, number>
  warnings: string[]
}

export function splitKmByCountry(encodedPolyline: string, spans: CountrySpan[]): CountrySplitResult {
  const warnings: string[] = []
  const kmByCountry: Record<string, number> = {}

  const { polyline } = decode(encodedPolyline)
  if (polyline.length < 2) {
    warnings.push('Polyline has fewer than 2 points — no distance can be derived.')
    return { kmByCountry, warnings }
  }
  if (spans.length === 0) {
    warnings.push('Section has no country spans — per-country km unavailable for this section.')
    return { kmByCountry, warnings }
  }

  const sorted = [...spans].sort((a, b) => a.offset - b.offset)
  for (let i = 0; i < sorted.length; i++) {
    const span = sorted[i]!
    const start = span.offset
    const end = i + 1 < sorted.length ? sorted[i + 1]!.offset : polyline.length - 1
    if (start < 0 || start >= polyline.length) {
      warnings.push(`Span offset ${start} is outside the polyline (${polyline.length} points) — span skipped.`)
      continue
    }
    let km = 0
    for (let p = start; p < Math.min(end, polyline.length - 1); p++) {
      const [lat1, lon1] = polyline[p]!
      const [lat2, lon2] = polyline[p + 1]!
      km += haversineKm(lat1!, lon1!, lat2!, lon2!)
    }
    kmByCountry[span.countryCode] = (kmByCountry[span.countryCode] ?? 0) + km
  }

  return { kmByCountry, warnings }
}
