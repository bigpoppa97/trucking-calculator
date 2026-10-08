import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CalculatorConfig } from '@domain'
import type { FetchedRouteDto, RouteDetailsDto } from '../lib/types.js'
import { CalculatorPage } from './CalculatorPage.js'

// Leaflet needs a real layout engine — stub react-leaflet out; the map's own
// behavior is covered by RoutePreview.test.tsx.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: React.ReactNode }) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => null,
  Polyline: () => null,
  CircleMarker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useMap: () => ({ fitBounds: () => {} }),
}))

vi.mock('../lib/api.js', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/api.js')>()
  return {
    ...original,
    api: {
      getConfig: vi.fn(),
      getFleetVariants: vi.fn(),
      getAirports: vi.fn(),
      getRoute: vi.fn(),
      fetchRouteFromHere: vi.fn(),
      saveFetchedRoute: vi.fn(),
      saveCalculation: vi.fn(),
      fillRouteFromHere: vi.fn(),
    },
  }
})

const { api } = await import('../lib/api.js')
const mocked = vi.mocked(api)

const CONFIG: CalculatorConfig = {
  fuelPriceEurPerLitre: 1.4,
  fuelConsumptionLPer100Km: 28,
  driverDayRateEur: 160,
  monthlyOverheadEur: 1122, // prototype value → reference totals apply
  monthDays: 30,
}

const VARIANTS = [
  { id: 1, name: 'standard cooler', monthlyCostEur: 3500, active: true }, // prototype fleet cost
  { id: 2, name: 'mega COOL', monthlyCostEur: 4500, active: true },
]

const WAW_PRG: RouteDetailsDto = {
  id: 1,
  routeCode: 'WAW-PRG',
  stops: ['WAW', 'PRG'],
  totalKm: 680,
  kmSource: 'manual',
  kmNote: null,
  kmUpdatedBy: null,
  kmUpdatedAt: null,
  countryKm: { PL: 420, CZ: 260 },
  tolls: [
    { country: 'PL', tollEur: 102, status: 'verified', fetchedAt: null, verifiedBy: 'v1-import', verifiedAt: '2026-01-01' },
    { country: 'CZ', tollEur: 35, status: 'verified', fetchedAt: null, verifiedBy: 'v1-import', verifiedAt: '2026-01-01' },
  ],
  tollsPendingCountries: [],
  polylineSections: null,
}

const FETCHED_WAW_OSL: FetchedRouteDto = {
  routeCode: 'WAW-OSL',
  stops: ['WAW', 'OSL'],
  totalKm: 1250,
  countryKm: { PL: 300, DE: 700, DK: 150, SE: 50, NO: 50 },
  tollEstimates: { PL: 45.5, DE: 190.25 },
  sections: [],
  vehicleProfile: { axleCount: 5, grossWeightKg: 40000, emissionType: 'euro6' },
  fetchedAt: '2026-07-02T12:00:00.000Z',
  warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.getConfig.mockResolvedValue(CONFIG)
  mocked.getFleetVariants.mockResolvedValue(VARIANTS)
  mocked.getAirports.mockResolvedValue([])
})

async function renderPage() {
  const user = userEvent.setup()
  render(<CalculatorPage />)
  await waitFor(() => expect(screen.getByLabelText('Kod trasy')).toBeInTheDocument())
  return user
}

async function lookupRoute(user: Awaited<ReturnType<typeof renderPage>>, code: string) {
  const input = screen.getByLabelText('Kod trasy')
  await user.clear(input)
  await user.type(input, code)
  await user.click(screen.getByRole('button', { name: 'Sprawdź trasę' }))
}

describe('table-first lookup (PRD §3.2)', () => {
  it('shows a stored route with the from-database indicator and NO HERE call', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')

    expect(await screen.findByTestId('route-status')).toHaveTextContent('z bazy tras')
    expect(screen.getByTestId('route-total-km')).toHaveTextContent('680 km')
    expect(mocked.fetchRouteFromHere).not.toHaveBeenCalled()
  })

  it('asks for explicit confirmation before calling HERE for an unknown route', async () => {
    mocked.getRoute.mockResolvedValue(null)
    mocked.fetchRouteFromHere.mockResolvedValue(FETCHED_WAW_OSL)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-OSL')

    // Not called yet — only after the user confirms
    expect(await screen.findByTestId('route-status')).toHaveTextContent('nowa trasa')
    expect(mocked.fetchRouteFromHere).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Zapytaj HERE API' }))
    await waitFor(() => expect(mocked.fetchRouteFromHere).toHaveBeenCalledWith('WAW-OSL'))
    expect(await screen.findByTestId('route-status')).toHaveTextContent('opłaty niezweryfikowane')
    expect(screen.getByRole('button', { name: 'Zapisz do bazy tras' })).toBeInTheDocument()
  })

  it('saves a fetched route on request', async () => {
    mocked.getRoute.mockResolvedValue(null)
    mocked.fetchRouteFromHere.mockResolvedValue(FETCHED_WAW_OSL)
    mocked.saveFetchedRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-OSL')
    await user.click(await screen.findByRole('button', { name: 'Zapytaj HERE API' }))
    await user.click(await screen.findByRole('button', { name: 'Zapisz do bazy tras' }))

    await waitFor(() => expect(mocked.saveFetchedRoute).toHaveBeenCalledWith(FETCHED_WAW_OSL))
    expect(await screen.findByText('Zapisano w bazie tras.')).toBeInTheDocument()
  })
})

describe('stale-data rule (PRD §5.4 — the v1 stale-toll bug)', () => {
  it('clears ALL previous route values when the next lookup is not found', async () => {
    mocked.getRoute.mockResolvedValueOnce(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    expect(await screen.findByTestId('toll-PL')).toHaveTextContent('102')

    mocked.getRoute.mockResolvedValueOnce(null)
    await lookupRoute(user, 'XXX-YYY')
    expect(await screen.findByTestId('route-status')).toHaveTextContent('nowa trasa')

    // No toll or km values from WAW-PRG survive
    expect(screen.queryByTestId('toll-PL')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-total-km')).not.toBeInTheDocument()
    expect(screen.queryByTestId('total-cost')).not.toBeInTheDocument()
  })

  it('clears previous values when the lookup errors', async () => {
    mocked.getRoute.mockResolvedValueOnce(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    expect(await screen.findByTestId('toll-PL')).toBeInTheDocument()

    const { ApiError } = await import('../lib/api.js')
    mocked.getRoute.mockRejectedValueOnce(new ApiError('NETWORK', 'Brak połączenia z serwerem.'))
    await lookupRoute(user, 'WAW-BUD')

    expect(await screen.findByRole('alert')).toHaveTextContent('Brak połączenia')
    expect(screen.queryByTestId('toll-PL')).not.toBeInTheDocument()
  })
})

describe('live calculation (validated reference case)', () => {
  it('reproduces the WAW-PRG prototype total with 1 day, 1 driver, standard fleet', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')

    const total = await screen.findByTestId('total-cost')
    // 266.56 + 137 + 116.67 + 160 + 37.40 → 717.63 (rounded raw sum)
    expect(total).toHaveTextContent('717,63')
  })

  it('accepts comma-decimal input and recalculates live', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    await screen.findByTestId('total-cost')

    const days = screen.getByLabelText('Dni (min 0,5)')
    await user.clear(days)
    await user.type(days, '1,5')
    // drivers: 1.5×160=240 (+80), fleet: 175 (+58.33), overhead: 56.10 (+18.70)
    // 266.56 + 137 + 175 + 240 + 56.1 = 874.66
    await waitFor(() => expect(screen.getByTestId('total-cost')).toHaveTextContent('874,66'))
  })

  it('shows P&L when revenue is entered', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    await screen.findByTestId('total-cost')

    await user.type(screen.getByLabelText(/Przychód/), '900')
    await waitFor(() => expect(screen.getByTestId('profit')).toHaveTextContent('182,37'))
  })

  it('shows a specific inline message for invalid days instead of an error state', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    await screen.findByTestId('total-cost')

    const days = screen.getByLabelText('Dni (min 0,5)')
    await user.clear(days)
    await user.type(days, '0,3')

    expect(await screen.findByText('Min. 0,5 dnia, krok co 0,5.')).toBeInTheDocument()
    expect(screen.queryByTestId('total-cost')).not.toBeInTheDocument()
  })

  it('flags estimate-based tolls in the breakdown (PRD §4.3)', async () => {
    mocked.getRoute.mockResolvedValue(null)
    mocked.fetchRouteFromHere.mockResolvedValue(FETCHED_WAW_OSL)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-OSL')
    await user.click(await screen.findByRole('button', { name: 'Zapytaj HERE API' }))

    await screen.findByTestId('total-cost')
    expect(screen.getByText(/szacunki z HERE/)).toBeInTheDocument()
    expect(screen.getByText(/Brak opłat drogowych dla: DK, SE, NO/)).toBeInTheDocument()
  })
})

describe('saving calculations (history, PRD §5.3)', () => {
  it('saves a calculation for a database route with the parsed inputs', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    mocked.saveCalculation.mockResolvedValue({} as never)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    await screen.findByTestId('total-cost')

    const days = screen.getByLabelText('Dni (min 0,5)')
    await user.clear(days)
    await user.type(days, '1,5')
    await user.type(screen.getByLabelText(/Przychód/), '900')

    await user.click(screen.getByRole('button', { name: 'Zapisz kalkulację' }))
    await waitFor(() =>
      expect(mocked.saveCalculation).toHaveBeenCalledWith({
        routeCode: 'WAW-PRG',
        days: 1.5,
        drivers: 1,
        fleetVariantId: 1,
        ferriesEur: 0,
        tunnelsEur: 0,
        revenueEur: 900,
      }),
    )
    expect(await screen.findByRole('button', { name: 'Zapisano ✓' })).toBeDisabled()
  })

  it('blocks saving until a fetched route is saved to the database', async () => {
    mocked.getRoute.mockResolvedValue(null)
    mocked.fetchRouteFromHere.mockResolvedValue(FETCHED_WAW_OSL)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-OSL')
    await user.click(await screen.findByRole('button', { name: 'Zapytaj HERE API' }))
    await screen.findByTestId('total-cost')

    expect(screen.getByRole('button', { name: 'Zapisz kalkulację' })).toBeDisabled()
    expect(screen.getByText(/Najpierw zapisz trasę do bazy/)).toBeInTheDocument()
  })
})

describe('fleet variant select (PRD §5.4 — free text impossible)', () => {
  it('renders variants as a constrained select and recalculates on change', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    await screen.findByTestId('total-cost')

    const select = screen.getByLabelText('Wariant taboru')
    expect(select.tagName).toBe('SELECT')

    await user.selectOptions(select, 'mega COOL')
    // fleet: 4500/30 = 150 vs 116.67 → total 751.local: 266.56+137+150+160+37.4 = 750.96
    await waitFor(() => expect(screen.getByTestId('total-cost')).toHaveTextContent('750,96'))
  })
})

describe('"Uzupełnij z HERE" for a stored route with gaps', () => {
  const WAW_PRG_GAPS: RouteDetailsDto = {
    ...WAW_PRG,
    totalKm: 680,
    countryKm: { PL: 420 }, // v1 sheet without a CZ column
    tolls: [],
    tollsPendingCountries: ['PL'],
  }
  const FILLED: RouteDetailsDto = {
    ...WAW_PRG_GAPS,
    countryKm: { PL: 420, CZ: 255.3 },
    tolls: [
      { country: 'PL', tollEur: 98.5, status: 'estimate', fetchedAt: '2026-10-06T09:00:00Z', verifiedBy: null, verifiedAt: null },
      { country: 'CZ', tollEur: 33.2, status: 'estimate', fetchedAt: '2026-10-06T09:00:00Z', verifiedBy: null, verifiedAt: null },
    ],
    tollsPendingCountries: [],
  }

  it('fills the gaps after confirmation and recalculates from the filled route', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG_GAPS)
    mocked.fillRouteFromHere.mockResolvedValue({
      route: FILLED,
      summary: {
        addedCountryKm: { CZ: 255.3 },
        addedTolls: { PL: 98.5, CZ: 33.2 },
        keptTollCountries: [],
        stillPendingCountries: [],
        hereTotalKm: 675.4,
        warnings: [],
      },
    })
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')

    // Without tolls: 266.56 + 0 + 116.67 + 160 + 37.40
    expect(await screen.findByTestId('total-cost')).toHaveTextContent('580,63')
    expect(screen.getByText('Brak opłat dla: PL.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Uzupełnij z HERE' }))
    expect(mocked.fillRouteFromHere).not.toHaveBeenCalled() // explicit confirmation first
    await user.click(screen.getByRole('button', { name: 'Pobierz z HERE' }))

    await waitFor(() => expect(mocked.fillRouteFromHere).toHaveBeenCalledWith('WAW-PRG'))
    // + 98.50 + 33.20 tolls
    await waitFor(() => expect(screen.getByTestId('total-cost')).toHaveTextContent('712,33'))
    expect(screen.getByText('Uzupełniono z HERE ✓')).toBeInTheDocument()
    expect(screen.getByText(/Dodane kraje: CZ 255,3 km/)).toBeInTheDocument()
  })

  it('offers nothing for a complete route', async () => {
    mocked.getRoute.mockResolvedValue(WAW_PRG)
    const user = await renderPage()
    await lookupRoute(user, 'WAW-PRG')
    await screen.findByTestId('total-cost')
    expect(screen.queryByRole('button', { name: 'Uzupełnij z HERE' })).not.toBeInTheDocument()
  })
})
