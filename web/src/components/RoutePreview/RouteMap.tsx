import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import { decode } from '@here/flexpolyline'
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet'
import type { AirportDto, PolylineSectionDto } from '../../lib/types.js'
import 'leaflet/dist/leaflet.css'

/**
 * Left panel of the route preview: the HERE route shape on OSM tiles,
 * color-coded per country, with airport markers. Display-only (sprint rule).
 * CircleMarkers are used instead of Leaflet's default icons — no bundler
 * asset fix needed and they match the reference layout.
 */

/** One color per country, assigned in driving order. */
const SEGMENT_COLORS = ['#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777', '#4f46e5']

export interface RouteMapProps {
  stops: string[]
  airports: AirportDto[]
  /** Null → no stored shape; straight dashed line fallback. */
  sections: PolylineSectionDto[] | null
}

interface CountrySegment {
  country: string
  color: string
  points: LatLngExpression[]
}

function buildSegments(sections: PolylineSectionDto[]): CountrySegment[] {
  const colorByCountry = new Map<string, string>()
  const segments: CountrySegment[] = []
  for (const section of sections) {
    const points = decode(section.polyline).polyline.map(([lat, lon]) => [lat, lon] as LatLngExpression)
    if (points.length === 0) continue
    const spans = [...section.spans].sort((a, b) => a.offset - b.offset)
    if (spans.length === 0) {
      segments.push({ country: '', color: SEGMENT_COLORS[0]!, points })
      continue
    }
    for (const [i, span] of spans.entries()) {
      if (!colorByCountry.has(span.country)) {
        colorByCountry.set(span.country, SEGMENT_COLORS[colorByCountry.size % SEGMENT_COLORS.length]!)
      }
      // +1 so consecutive segments share the border point and the line connects.
      const end = i + 1 < spans.length ? spans[i + 1]!.offset + 1 : points.length
      segments.push({
        country: span.country,
        color: colorByCountry.get(span.country)!,
        points: points.slice(span.offset, end),
      })
    }
  }
  return segments.filter(s => s.points.length >= 2)
}

/** Imperatively fit the viewport to the route whenever it changes. */
function FitBounds({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap()
  useEffect(() => {
    if (bounds !== null) map.fitBounds(bounds, { padding: [20, 20] })
  }, [map, bounds])
  return null
}

export function RouteMap({ stops, airports, sections }: RouteMapProps) {
  const airportByIata = useMemo(() => new Map(airports.map(a => [a.iata, a])), [airports])
  const stopPoints = stops
    .map(iata => ({ iata, airport: airportByIata.get(iata) }))
    .filter((s): s is { iata: string; airport: AirportDto } => s.airport !== undefined)

  const segments = useMemo(() => (sections === null ? null : buildSegments(sections)), [sections])

  const bounds = useMemo((): LatLngBoundsExpression | null => {
    const points: Array<[number, number]> =
      segments !== null && segments.length > 0
        ? segments.flatMap(s => s.points as Array<[number, number]>)
        : stopPoints.map(s => [s.airport.lat, s.airport.lon])
    if (points.length < 2) return null
    const lats = points.map(p => p[0])
    const lons = points.map(p => p[1])
    return [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ]
  }, [segments, stopPoints])

  if (stopPoints.length < 2 && (segments === null || segments.length === 0)) {
    return (
      <p className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
        Podgląd mapy niedostępny — brak współrzędnych lotnisk tej trasy.
      </p>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-200 shadow-sm" data-testid="route-map">
      <MapContainer style={{ height: 380, width: '100%' }} center={[52, 19]} zoom={5} scrollWheelZoom={false}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds bounds={bounds} />

        {segments !== null ? (
          segments.map((segment, i) => (
            <Polyline key={i} positions={segment.points} pathOptions={{ color: segment.color, weight: 4, opacity: 0.8 }} />
          ))
        ) : (
          <Polyline
            positions={stopPoints.map(s => [s.airport.lat, s.airport.lon] as LatLngExpression)}
            pathOptions={{ color: '#2563eb', weight: 3, opacity: 0.6, dashArray: '8 8' }}
          />
        )}

        {stopPoints.map((stop, i) => {
          const isEndpoint = i === 0 || i === stopPoints.length - 1
          return (
            <CircleMarker
              key={stop.iata}
              center={[stop.airport.lat, stop.airport.lon]}
              radius={isEndpoint ? 8 : 5}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: isEndpoint ? '#dc2626' : '#2563eb',
                fillOpacity: 1,
              }}
            >
              <Tooltip permanent direction="top" offset={[0, -8]}>
                {stop.iata}
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>
      {segments === null && (
        <p className="border-t border-slate-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          Podgląd trasy niedostępny — trasa z bazy danych (linia prosta między lotniskami).
        </p>
      )}
    </div>
  )
}
