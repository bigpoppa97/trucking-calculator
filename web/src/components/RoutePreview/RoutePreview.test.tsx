import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { encode } from '@here/flexpolyline'
import type { AirportDto } from '../../lib/types.js'
import { TollBreakdown } from './TollBreakdown.js'
import { RoutePreview } from './RoutePreview.js'

// Leaflet needs a real layout engine — mock react-leaflet so component logic
// (fallback vs shape, marker/polyline props) is testable in jsdom.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: React.ReactNode }) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Polyline: ({ pathOptions }: { pathOptions?: { color?: string; dashArray?: string } }) => (
    <div data-testid="polyline" data-color={pathOptions?.color} data-dash={pathOptions?.dashArray} />
  ),
  CircleMarker: ({ children, pathOptions }: { children?: React.ReactNode; pathOptions?: { fillColor?: string } }) => (
    <div data-testid="circle-marker" data-fill={pathOptions?.fillColor}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useMap: () => ({ fitBounds: () => {} }),
}))

const AIRPORTS: AirportDto[] = [
  { iata: 'WAW', name: 'Warsaw Chopin', city: 'Warsaw', country: 'PL', lat: 52.1657, lon: 20.9671 },
  { iata: 'BER', name: 'Berlin Brandenburg', city: 'Berlin', country: 'DE', lat: 52.3667, lon: 13.5033 },
  { iata: 'FRA', name: 'Frankfurt', city: 'Frankfurt', country: 'DE', lat: 50.0333, lon: 8.5706 },
]

describe('TollBreakdown', () => {
  it('renders flags, Polish names, km, amounts, badges and the total', () => {
    render(
      <TollBreakdown
        rows={[
          { country: 'PL', km: 420, tollEur: 102, status: 'verified' },
          { country: 'CZ', km: 260, tollEur: 35, status: 'estimate' },
          { country: 'DE', km: 10, tollEur: null, status: 'missing' },
        ]}
      />,
    )
    const panel = screen.getByRole('region', { name: 'Autostrady — podział na kraje' })
    expect(within(panel).getByText('🇵🇱')).toBeInTheDocument()
    expect(within(panel).getByText('Polska')).toBeInTheDocument()
    expect(within(panel).getByText('Czechy')).toBeInTheDocument()
    expect(within(panel).getByText('Niemcy')).toBeInTheDocument()
    expect(within(panel).getByText('102,00 €')).toBeInTheDocument()
    expect(within(panel).getByText('35,00 €')).toBeInTheDocument()
    expect(within(panel).getByText('szacunek')).toBeInTheDocument()
    expect(within(panel).getByText('—')).toBeInTheDocument()
    // Total = 102 + 35, in the header and in the total row.
    expect(within(panel).getAllByText('137,00 €')).toHaveLength(2)
  })
})

describe('RoutePreview / RouteMap', () => {
  it('renders a dashed straight-line fallback with a note when there is no stored shape', () => {
    render(
      <RoutePreview
        stops={['WAW', 'FRA']}
        airports={AIRPORTS}
        sections={null}
        countryKm={{ PL: 420, DE: 660 }}
        tolls={[{ country: 'PL', tollEur: 102, status: 'verified' }]}
      />,
    )
    expect(screen.getByText(/Podgląd trasy niedostępny — trasa z bazy danych/)).toBeInTheDocument()
    const line = screen.getByTestId('polyline')
    expect(line.dataset['dash']).toBe('8 8')
    // Origin + destination markers with IATA labels
    expect(screen.getAllByTestId('circle-marker')).toHaveLength(2)
    expect(screen.getByText('WAW')).toBeInTheDocument()
    expect(screen.getByText('FRA')).toBeInTheDocument()
  })

  it('offers the shape backfill button in the fallback banner and reports failure explicitly', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const onRefreshShape = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('boom'))
    render(
      <RoutePreview
        stops={['WAW', 'FRA']}
        airports={AIRPORTS}
        sections={null}
        countryKm={{ PL: 420 }}
        tolls={[{ country: 'PL', tollEur: 102, status: 'verified' }]}
        onRefreshShape={onRefreshShape}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Pobierz przebieg drogi z HERE/ }))
    expect(onRefreshShape).toHaveBeenCalledOnce()
    expect(await screen.findByRole('alert')).toHaveTextContent('Nie udało się pobrać kształtu trasy')
  })

  it('renders country-colored solid segments and via markers when the shape is stored', () => {
    const polyline = encode({
      polyline: [
        [52.17, 20.97],
        [52.3, 17.0],
        [52.37, 13.5],
        [50.03, 8.57],
      ],
      precision: 5,
    })
    render(
      <RoutePreview
        stops={['WAW', 'BER', 'FRA']}
        airports={AIRPORTS}
        sections={[{ polyline, spans: [{ offset: 0, country: 'PL' }, { offset: 2, country: 'DE' }] }]}
        countryKm={{ PL: 400, DE: 700 }}
        tolls={[
          { country: 'PL', tollEur: 102, status: 'verified' },
          { country: 'DE', tollEur: 190, status: 'estimate' },
        ]}
      />,
    )
    expect(screen.queryByText(/Podgląd trasy niedostępny/)).not.toBeInTheDocument()
    const lines = screen.getAllByTestId('polyline')
    expect(lines).toHaveLength(2) // one segment per country span
    expect(lines[0]?.dataset['color']).not.toBe(lines[1]?.dataset['color'])
    expect(lines[0]?.dataset['dash']).toBeUndefined()
    // Endpoints red, via point blue
    const markers = screen.getAllByTestId('circle-marker')
    expect(markers.map(m => m.dataset['fill'])).toEqual(['#dc2626', '#2563eb', '#dc2626'])
  })

  it('orders breakdown rows by driving order from the route shape', () => {
    const polyline = encode({
      polyline: [
        [52.17, 20.97],
        [52.37, 13.5],
        [50.03, 8.57],
      ],
      precision: 5,
    })
    render(
      <RoutePreview
        stops={['WAW', 'FRA']}
        airports={AIRPORTS}
        sections={[{ polyline, spans: [{ offset: 0, country: 'PL' }, { offset: 1, country: 'DE' }] }]}
        countryKm={{ DE: 660, PL: 420 }}
        tolls={[
          { country: 'DE', tollEur: 190, status: 'estimate' },
          { country: 'PL', tollEur: 102, status: 'verified' },
        ]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]?.textContent).toContain('Polska')
    expect(items[1]?.textContent).toContain('Niemcy')
  })
})
