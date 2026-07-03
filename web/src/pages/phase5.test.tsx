import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CalculationDto, RouteDetailsDto, RouteSummaryDto } from '../lib/types.js'
import { RouteDbPage } from './RouteDbPage.js'
import { ConfigPage } from './ConfigPage.js'
import { HistoryPage } from './HistoryPage.js'

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
      listRoutes: vi.fn(),
      overrideKm: vi.fn(),
      setToll: vi.fn(),
      verifyToll: vi.fn(),
      updateConfig: vi.fn(),
      createVariant: vi.fn(),
      patchVariant: vi.fn(),
      saveCalculation: vi.fn(),
      listCalculations: vi.fn(),
    },
  }
})

const { api } = await import('../lib/api.js')
const mocked = vi.mocked(api)

const SUMMARIES: RouteSummaryDto[] = [
  { id: 1, routeCode: 'WAW-PRG', totalKm: 680, kmSource: 'manual', createdAt: '2026-07-01', tollsPending: false, hasEstimates: false },
  { id: 2, routeCode: 'WAW-OSL', totalKm: 1250, kmSource: 'here', createdAt: '2026-07-02', tollsPending: true, hasEstimates: true },
]

const WAW_OSL: RouteDetailsDto = {
  id: 2,
  routeCode: 'WAW-OSL',
  stops: ['WAW', 'OSL'],
  totalKm: 1250,
  kmSource: 'here',
  kmNote: null,
  kmUpdatedBy: null,
  kmUpdatedAt: null,
  countryKm: { PL: 300, DE: 700, DK: 150 },
  tolls: [
    { country: 'PL', tollEur: 45.5, status: 'estimate', fetchedAt: '2026-07-02', verifiedBy: null, verifiedAt: null },
    { country: 'DE', tollEur: 190.25, status: 'verified', fetchedAt: null, verifiedBy: 'finance', verifiedAt: '2026-07-02' },
  ],
  tollsPendingCountries: ['DK'],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RouteDbPage (PRD §5.3)', () => {
  it('lists routes and the pending filter hides fully verified ones', async () => {
    mocked.listRoutes.mockResolvedValue(SUMMARIES)
    const user = userEvent.setup()
    render(<RouteDbPage />)

    expect(await screen.findByText('WAW-PRG')).toBeInTheDocument()
    expect(screen.getByText('WAW-OSL')).toBeInTheDocument()

    await user.click(screen.getByLabelText(/tylko opłaty do weryfikacji/))
    expect(screen.queryByText('WAW-PRG')).not.toBeInTheDocument()
    expect(screen.getByText('WAW-OSL')).toBeInTheDocument()
  })

  it('verifies an estimate with a corrected value and refreshes the view', async () => {
    mocked.listRoutes.mockResolvedValue(SUMMARIES)
    mocked.getRoute.mockResolvedValue(WAW_OSL)
    const verified: RouteDetailsDto = {
      ...WAW_OSL,
      tolls: WAW_OSL.tolls.map(t =>
        t.country === 'PL' ? { ...t, tollEur: 48, status: 'verified' as const, verifiedBy: 'portal-user' } : t,
      ),
    }
    mocked.verifyToll.mockResolvedValue(verified)
    const user = userEvent.setup()
    render(<RouteDbPage />)

    await user.click(await screen.findByText('WAW-OSL'))
    const detail = await screen.findByRole('region', { name: 'Szczegóły trasy WAW-OSL' })
    expect(within(detail).getByText('szacunek z HERE')).toBeInTheDocument()

    const input = within(detail).getByLabelText('Kwota opłaty PL')
    await user.clear(input)
    await user.type(input, '48')
    await user.click(within(detail).getByRole('button', { name: 'Zweryfikuj' }))

    await waitFor(() => expect(mocked.verifyToll).toHaveBeenCalledWith('WAW-OSL', 'PL', 48))
    expect(await within(detail).findByText(/zweryfikowana · portal-user/)).toBeInTheDocument()
  })

  it('fills a pending toll via setToll (manual entry → verified)', async () => {
    mocked.listRoutes.mockResolvedValue(SUMMARIES)
    mocked.getRoute.mockResolvedValue(WAW_OSL)
    mocked.setToll.mockResolvedValue(WAW_OSL)
    const user = userEvent.setup()
    render(<RouteDbPage />)

    await user.click(await screen.findByText('WAW-OSL'))
    const detail = await screen.findByRole('region', { name: 'Szczegóły trasy WAW-OSL' })

    await user.type(within(detail).getByLabelText('Kwota opłaty DK'), '0')
    await user.click(within(detail).getByRole('button', { name: 'Zapisz opłatę' }))
    await waitFor(() => expect(mocked.setToll).toHaveBeenCalledWith('WAW-OSL', 'DK', 0))
  })

  it('sends a manual km override with an audit note', async () => {
    mocked.listRoutes.mockResolvedValue(SUMMARIES)
    mocked.getRoute.mockResolvedValue(WAW_OSL)
    mocked.overrideKm.mockResolvedValue({ ...WAW_OSL, totalKm: 1240, kmSource: 'manual' })
    const user = userEvent.setup()
    render(<RouteDbPage />)

    await user.click(await screen.findByText('WAW-OSL'))
    await user.click(await screen.findByRole('button', { name: 'Koryguj km ręcznie' }))

    const total = screen.getByLabelText('Łącznie km')
    await user.clear(total)
    await user.type(total, '1240')
    await user.type(screen.getByLabelText(/Notatka/), 'nasza trasa przez Świnoujście')
    await user.click(screen.getByRole('button', { name: 'Zapisz km' }))

    await waitFor(() =>
      expect(mocked.overrideKm).toHaveBeenCalledWith('WAW-OSL', {
        totalKm: 1240,
        countryKm: { PL: 300, DE: 700, DK: 150 },
        note: 'nasza trasa przez Świnoujście',
      }),
    )
  })
})

describe('ConfigPage (finance)', () => {
  beforeEach(() => {
    mocked.getConfig.mockResolvedValue({
      fuelPriceEurPerLitre: 1.4,
      fuelConsumptionLPer100Km: 28,
      driverDayRateEur: 160,
      monthlyOverheadEur: 3012,
      monthDays: 30,
    })
    mocked.getFleetVariants.mockResolvedValue([
      { id: 1, name: 'standard cooler', monthlyCostEur: 2750, active: true },
    ])
  })

  it('saves edited values, accepting comma decimals', async () => {
    mocked.updateConfig.mockResolvedValue({
      fuelPriceEurPerLitre: 1.52,
      fuelConsumptionLPer100Km: 28,
      driverDayRateEur: 160,
      monthlyOverheadEur: 3012,
      monthDays: 30,
    })
    const user = userEvent.setup()
    render(<ConfigPage />)

    const fuel = await screen.findByLabelText('Cena paliwa (EUR/L)')
    await user.clear(fuel)
    await user.type(fuel, '1,52')
    await user.click(screen.getByRole('button', { name: 'Zapisz konfigurację' }))

    await waitFor(() =>
      expect(mocked.updateConfig).toHaveBeenCalledWith({
        fuelPriceEurPerLitre: 1.52,
        fuelConsumptionLPer100Km: 28,
        driverDayRateEur: 160,
        monthlyOverheadEur: 3012,
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Konfiguracja zapisana')
  })

  it('rejects non-numeric input with a message instead of calling the API', async () => {
    const user = userEvent.setup()
    render(<ConfigPage />)

    const fuel = await screen.findByLabelText('Cena paliwa (EUR/L)')
    await user.clear(fuel)
    await user.type(fuel, 'abc')
    await user.click(screen.getByRole('button', { name: 'Zapisz konfigurację' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Popraw wartości')
    expect(mocked.updateConfig).not.toHaveBeenCalled()
  })

  it('adds a fleet variant and toggles active state', async () => {
    mocked.createVariant.mockResolvedValue([
      { id: 1, name: 'standard cooler', monthlyCostEur: 2750, active: true },
      { id: 2, name: 'mega FRIGO', monthlyCostEur: 4800, active: true },
    ])
    mocked.patchVariant.mockResolvedValue([
      { id: 1, name: 'standard cooler', monthlyCostEur: 2750, active: false },
    ])
    const user = userEvent.setup()
    render(<ConfigPage />)

    await user.type(await screen.findByLabelText('Nowy wariant'), 'mega FRIGO')
    await user.type(screen.getByLabelText('Koszt/mies. (EUR)'), '4800')
    await user.click(screen.getByRole('button', { name: 'Dodaj wariant' }))
    await waitFor(() => expect(mocked.createVariant).toHaveBeenCalledWith('mega FRIGO', 4800))
    expect(await screen.findByText('mega FRIGO')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Aktywny: standard cooler'))
    await waitFor(() => expect(mocked.patchVariant).toHaveBeenCalledWith(1, { active: false }))
  })
})

describe('HistoryPage (frozen snapshots)', () => {
  const CALC: CalculationDto = {
    id: 1,
    routeCode: 'WAW-PRG',
    days: 1,
    drivers: 1,
    fleetVariantId: 1,
    ferriesEur: 0,
    tunnelsEur: 0,
    revenueEur: 900,
    createdBy: 'portal-user',
    createdAt: '2026-07-02 12:00:00',
    snapshot: {
      input: {
        routeCode: 'WAW-PRG',
        totalKm: 680,
        orderDays: 1,
        driverCount: 1,
        fleetVariantName: 'standard cooler',
        fleetMonthlyCostEur: 3500,
        ferriesEur: 0,
        tunnelsEur: 0,
        revenueEur: 900,
      },
      config: {
        fuelPriceEurPerLitre: 1.4,
        fuelConsumptionLPer100Km: 28,
        driverDayRateEur: 160,
        monthlyOverheadEur: 1122,
        monthDays: 30,
      },
      breakdown: {
        fuelEur: 266.56,
        highwaysEur: 137,
        fleetEur: 116.67,
        driversEur: 160,
        overheadEur: 37.4,
        ferriesTunnelsEur: 0,
        totalEur: 717.63,
        tollWarnings: { estimatedCountries: [], missingCountries: [], usesEstimates: false, hasMissing: false },
        pnl: { revenueEur: 900, profitEur: 182.37, marginPct: 20.26 },
      },
    },
  }

  it('lists calculations and expands the frozen snapshot breakdown', async () => {
    mocked.listCalculations.mockResolvedValue([CALC])
    const user = userEvent.setup()
    render(<HistoryPage />)

    expect(await screen.findByText('WAW-PRG')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Szczegóły' }))

    expect(screen.getByText(/Zamrożony snapshot/)).toBeInTheDocument()
    expect(screen.getByTestId('total-cost')).toHaveTextContent('717,63')
    expect(screen.getByTestId('profit')).toHaveTextContent('182,37')
  })

  it('filters by route code', async () => {
    mocked.listCalculations.mockResolvedValue([CALC])
    const user = userEvent.setup()
    render(<HistoryPage />)
    await screen.findByText('WAW-PRG')

    mocked.listCalculations.mockResolvedValue([])
    await user.type(screen.getByLabelText('Filtr trasy'), 'WAW-BUD')
    await user.click(screen.getByRole('button', { name: 'Filtruj' }))

    await waitFor(() => expect(mocked.listCalculations).toHaveBeenLastCalledWith('WAW-BUD'))
    expect(await screen.findByText('Brak zapisanych kalkulacji.')).toBeInTheDocument()
  })
})
