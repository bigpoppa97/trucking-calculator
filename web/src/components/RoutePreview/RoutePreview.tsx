import { useMemo } from 'react'
import type { CountryToll } from '@domain'
import type { AirportDto, PolylineSectionDto } from '../../lib/types.js'
import { RouteMap } from './RouteMap.js'
import { TollBreakdown, type TollBreakdownRow } from './TollBreakdown.js'

/**
 * Route preview (sprint item): map with the route shape (left, ~65%) and
 * per-country highway cost breakdown (right, ~35%). Rows follow the driving
 * order when the route shape is stored; alphabetical otherwise.
 */

export interface RoutePreviewProps {
  stops: string[]
  airports: AirportDto[]
  sections: PolylineSectionDto[] | null
  countryKm: Record<string, number>
  tolls: CountryToll[]
}

export function RoutePreview({ stops, airports, sections, countryKm, tolls }: RoutePreviewProps) {
  const rows = useMemo((): TollBreakdownRow[] => {
    const tollByCountry = new Map(tolls.map(t => [t.country, t]))
    const countries = new Set([...Object.keys(countryKm), ...tolls.map(t => t.country)])

    const drivenOrder: string[] = []
    for (const section of sections ?? []) {
      for (const span of [...section.spans].sort((a, b) => a.offset - b.offset)) {
        if (!drivenOrder.includes(span.country)) drivenOrder.push(span.country)
      }
    }
    const ordered = [
      ...drivenOrder.filter(c => countries.has(c)),
      ...[...countries].filter(c => !drivenOrder.includes(c)).sort(),
    ]

    return ordered.map(country => {
      const toll = tollByCountry.get(country)
      return {
        country,
        km: countryKm[country] ?? null,
        tollEur: toll === undefined || toll.status === 'missing' ? null : toll.tollEur,
        status: toll?.status ?? 'missing',
      }
    })
  }, [sections, countryKm, tolls])

  if (rows.length === 0) return null

  return (
    <section aria-label="Podgląd trasy" className="grid gap-4 md:grid-cols-3">
      <div className="md:col-span-2">
        <RouteMap stops={stops} airports={airports} sections={sections} />
      </div>
      <TollBreakdown rows={rows} />
    </section>
  )
}
